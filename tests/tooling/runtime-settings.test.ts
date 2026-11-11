import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CI settings use image-pinned SQL and reject foreign containers, mismatched topics and group-only tampering", () => {
	const directory = mkdtempSync(join(tmpdir(), "recount-ci-settings-"));
	try {
		const project = "recount-ci-123-2";
		const output = join(directory, "github.env");
		const docker = join(directory, "docker");
		const mock = join(directory, "docker.ts");
		writeFileSync(
			docker,
			`#!/bin/sh\nexec '${process.execPath}' --no-env-file '${mock}' "$@"\n`,
		);
		chmodSync(docker, 0o755);
		writeFileSync(
			mock,
			`
const args = process.argv.slice(2);
const project = "${project}";
if (args[0] === "compose" && args.includes("ps")) console.log((args.at(-1) === "kafka" ? "b" : "a").repeat(64));
else if (args[0] === "compose" && args.includes("config")) console.log(JSON.stringify({ services: {
  "kafka-topics": { environment: { RECOUNT_RAW_TOPIC: "allocated.raw", RECOUNT_NORMALIZED_TOPIC: "allocated.normalized", RECOUNT_RAW_PARTITIONS: "7", RECOUNT_NORMALIZED_PARTITIONS: "11" } },
  clickhouse: { volumes: [{ type: "bind", source: process.env.MOCK_SCHEMA, target: "/etc/recount-schema" }] }
}}));
else if (args[0] === "inspect") {
  const format = args[args.indexOf("--format") + 1];
  if (format.includes("NetworkSettings")) console.log(JSON.stringify({ [project + "_broker"]: {} }));
  else if (format === "{{.Name}}") console.log("/owned-clickhouse");
  else {
    const role = args.at(-1) === "b".repeat(64) ? "kafka" : "clickhouse";
    console.log(args.at(-1) + "|" + (process.env.MOCK_FOREIGN === "1" ? "foreign" : project) + "|" + role + "|true");
  }
} else if (args[0] === "exec" && args[1] === "a".repeat(64) && args[2] === "cat" && args[3] === "/usr/share/recount-schema/SHA256SUMS") console.log(process.env.MOCK_PINNED);
else throw new Error("Unexpected Docker operation: " + args.join(" "));
`,
		);
		for (const scenario of [
			"selected",
			"foreign",
			"mismatch",
			"group-tampered",
			"manifest-group-tampered",
		]) {
			writeFileSync(output, "");
			const topic =
				scenario === "mismatch" ? "foreign.normalized" : "allocated.normalized";
			const pinnedSchema = `    kafka_topic_list = '${topic}',\n    kafka_group_name = 'allocated.native',\n`;
			const mountedSchema =
				scenario === "group-tampered"
					? pinnedSchema.replace("allocated.native", "foreign.native")
					: pinnedSchema;
			writeFileSync(join(directory, "schema.sql"), mountedSchema);
			writeFileSync(
				join(directory, "SHA256SUMS"),
				`${createHash("sha256").update(mountedSchema).digest("hex")}  schema.sql\n`,
			);
			writeFileSync(
				join(directory, "manifest.json"),
				JSON.stringify({
					normalized_topic:
						scenario === "mismatch"
							? "foreign.normalized"
							: "allocated.normalized",
					consumer_group:
						scenario === "manifest-group-tampered"
							? "foreign.native"
							: "allocated.native",
				}),
			);
			const result = Bun.spawnSync(
				[
					process.execPath,
					"--no-env-file",
					new URL("../ci/runtime-settings.ts", import.meta.url).pathname,
				],
				{
					env: {
						PATH: `${directory}:${process.env.PATH}`,
						HOME: process.env.HOME,
						CI: "true",
						GITHUB_ENV: output,
						GITHUB_RUN_ID: "123",
						GITHUB_RUN_ATTEMPT: "2",
						COMPOSE_PROJECT_NAME: project,
						RECOUNT_NORMALIZER_GROUP: "allocated.normalizer",
						MOCK_SCHEMA: directory,
						MOCK_PINNED: `${createHash("sha256").update(pinnedSchema).digest("hex")}  schema.sql`,
						MOCK_FOREIGN: scenario === "foreign" ? "1" : "0",
					},
					stdout: "pipe",
					stderr: "pipe",
					timeout: 5000,
				},
			);
			if (!["selected", "manifest-group-tampered"].includes(scenario)) {
				expect(result.exitCode).not.toBe(0);
				expect(readFileSync(output, "utf8")).toBe("");
				if (scenario === "group-tampered")
					expect(result.stderr.toString()).toContain("pinned schema");
				continue;
			}
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			const settings = Object.fromEntries(
				readFileSync(output, "utf8")
					.trim()
					.split("\n")
					.map((line) => line.split("=")),
			);
			expect(settings).toMatchObject({
				RECOUNT_PIPELINE_NATIVE_GROUP: "allocated.native",
				RECOUNT_PIPELINE_NORMALIZER_GROUP: "allocated.normalizer",
				RECOUNT_PIPELINE_RAW_PARTITIONS: "7",
				RECOUNT_PIPELINE_NORMALIZED_PARTITIONS: "11",
				RECOUNT_PIPELINE_RAW_TOPIC: "allocated.raw",
				RECOUNT_PIPELINE_NORMALIZED_TOPIC: "allocated.normalized",
				RECOUNT_STORAGE_TEST_CONTAINER_ID: "a".repeat(64),
			});
		}
	} finally {
		rmSync(directory, { recursive: true });
	}
});
