import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the image-pinned schema verifier rejects coherent artifact tampering", async () => {
	if (process.env.RECOUNT_RUNTIME_TEST_ALLOW_CONTAINERS !== "1")
		throw new Error("Explicit runtime-container permission required");
	const schema = process.env.RECOUNT_SCHEMA_DIRECTORY;
	const image = process.env.RECOUNT_CLICKHOUSE_IMAGE;
	if (!schema || !image)
		throw new Error(
			"Prepared schema directory and matching ClickHouse image required",
		);
	const inspect = Bun.spawnSync(
		["docker", "image", "inspect", "--format", "{{.Id}}", image],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(inspect.exitCode).toBe(0);
	const id = inspect.stdout.toString().trim();
	expect(id).toMatch(/^sha256:[a-f0-9]{64}$/);
	const directory = await mkdtemp(join(tmpdir(), "recount-schema-test-"));
	try {
		const bound = (await readFile(join(schema, "output-rows"), "utf8")).trim();
		const topicBytes = (
			await readFile(join(schema, "normalized-broker-max-bytes"), "utf8")
		).trim();
		const receiveBytes = (
			await readFile(join(schema, "kafka-receive-bytes"), "utf8")
		).trim();
		for (const scenario of [
			"valid",
			"omitted-description",
			"changed-description-type",
			"altered-proto",
			"row-bound-mismatch",
			"topic-budget-mismatch",
			"receive-budget-mismatch",
			"altered-transport",
		]) {
			const path = join(directory, scenario);
			await cp(resolve(schema), path, { recursive: true });
			if (
				["omitted-description", "changed-description-type"].includes(scenario)
			) {
				for (const filename of [
					"schema.sql",
					"analytical-columns.sql",
					"expected-columns.tsv",
				]) {
					const original = await readFile(join(path, filename), "utf8");
					const changed =
						scenario === "omitted-description"
							? original
									.split("\n")
									.filter((line) => !/^description[ \t]/.test(line.trimStart()))
									.join("\n")
							: original
									.replaceAll(
										"description String",
										"description Nullable(String)",
									)
									.replaceAll(
										"description\tString",
										"description\tNullable(String)",
									);
					expect(changed).not.toBe(original);
					await writeFile(join(path, filename), changed);
				}
				const files = (await readFile(join(path, "SHA256SUMS"), "utf8"))
					.trim()
					.split("\n")
					.map((line) => line.split("  ")[1]);
				const manifest: string[] = [];
				for (const file of files) {
					if (!file || file.startsWith("/") || file.split("/").includes(".."))
						throw new Error("Invalid schema manifest path");
					manifest.push(
						`${createHash("sha256")
							.update(await readFile(join(path, file)))
							.digest("hex")}  ${file}\n`,
					);
				}
				await writeFile(join(path, "SHA256SUMS"), manifest.join(""));
			}
			if (scenario === "altered-proto")
				await writeFile(
					join(path, "schemas/recount.proto"),
					`${await readFile(join(path, "schemas/recount.proto"), "utf8")}\n// altered fixture\n`,
				);
			if (scenario === "altered-transport")
				await writeFile(join(path, "native-transport.xml"), "<clickhouse/>\n");
			const result = Bun.spawnSync(
				[
					"docker",
					"run",
					"--rm",
					"--network",
					"none",
					"--read-only",
					"--memory",
					"128m",
					"--memory-swap",
					"128m",
					"--pids-limit",
					"64",
					"--cpus",
					"1",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--env",
					`RECOUNT_NORMALIZER_OUTPUT_ROWS=${Number(bound) + Number(scenario === "row-bound-mismatch")}`,
					"--env",
					`RECOUNT_NORMALIZED_BROKER_MAX_BYTES=${Number(topicBytes) + Number(scenario === "topic-budget-mismatch")}`,
					"--env",
					`RECOUNT_KAFKA_RECEIVE_BYTES=${Number(receiveBytes) + Number(scenario === "receive-budget-mismatch")}`,
					"--mount",
					`type=bind,src=${path},dst=/etc/recount-schema,readonly`,
					"--mount",
					`type=bind,src=${path}/schemas,dst=/etc/clickhouse-server/format_schemas,readonly`,
					"--mount",
					`type=bind,src=${path}/native-transport.xml,dst=/etc/clickhouse-server/config.d/native-transport.xml,readonly`,
					"--mount",
					`type=bind,src=${new URL("../../infra/clickhouse/verify-schema.sh", import.meta.url).pathname},dst=/verify-schema.sh,readonly`,
					"--entrypoint",
					"/bin/sh",
					id,
					"-ec",
					"sh /verify-schema.sh; printf guard-completed",
				],
				{ stdout: "pipe", stderr: "pipe", timeout: 15_000 },
			);
			expect(result.exitCode === 0, scenario).toBe(scenario === "valid");
			expect(
				result.stdout.toString().includes("guard-completed"),
				scenario,
			).toBe(scenario === "valid");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 90_000);
