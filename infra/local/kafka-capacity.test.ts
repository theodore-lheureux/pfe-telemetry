import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkpoints,
	effectiveSettings,
	headroom,
	offsets,
	partitionMetrics,
} from "./kafka-capacity";

test("capacity uses effective settings, never the inherited synonym", () => {
	const config = effectiveSettings(
		"  retention.ms=1000 sensitive=false synonyms={DEFAULT_CONFIG:log.retention.ms=6000}\n  retention.bytes=1024 sensitive=false",
	);
	expect(config.get("retention.ms")).toBe("1000");
	expect(offsets("raw:0:12\nraw:1:42", "raw").get(1)).toBe(42);
	expect(offsets("", "raw", true).size).toBe(0);
	expect(() => offsets("", "raw")).toThrow("No watermarks");
	expect(
		checkpoints(
			"GROUP TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG\nworker raw 0 12 20 8\nworker raw 1 - 42 -",
			"raw",
		).get(0),
	).toBe(12);
});

test("expired and missing checkpoints are explicit even at an empty retained tail", () => {
	const base = {
		low: 10,
		high: 20,
		saved: 12,
		bytes: 100,
		byteLimit: 1000,
		guard: 11,
	};
	expect(headroom(base)).toMatchObject({
		state: "ok",
		lag: 8,
		retainedPrefixRecords: 2,
		byteHeadroom: 900,
	});
	expect(headroom({ ...base, saved: 9 }).state).toBe("retention_gap");
	expect(
		partitionMetrics("raw", "worker", 0, headroom({ ...base, saved: 9 })),
	).toContain(
		'recount_kafka_retention_gap{topic="raw",group="worker",partition="0"} 1',
	);
	expect(partitionMetrics("raw", "worker", 0, headroom(base))).toContain(
		'recount_kafka_retention_gap{topic="raw",group="worker",partition="0"} 0',
	);
	expect(headroom({ ...base, high: 10, saved: 0 }).state).toBe("retention_gap");
	expect(headroom({ ...base, saved: 21 }).state).toBe("retention_gap");
	expect(headroom({ ...base, saved: Number.NaN }).state).toBe(
		"checkpoint_missing",
	);
	expect(headroom({ ...base, guard: 13 }).state).toBe("time_headroom_low");
	expect(headroom({ ...base, guard: -1 }).state).toBe("time_headroom_low");
	expect(headroom({ ...base, saved: 20, guard: -1 }).state).toBe("ok");
	expect(headroom({ ...base, bytes: 800 }).state).toBe("byte_headroom_low");
	expect(headroom({ ...base, saved: undefined }).lag).toBeUndefined();
	expect(() => headroom({ ...base, bytes: Number.NaN })).toThrow("Incomplete");
});

test("capacity exports gap gauges as warnings and never changes broker state", async () => {
	const directory = mkdtempSync(join(tmpdir(), "recount-capacity-"));
	const log = join(directory, "calls");
	const docker = join(directory, "docker");
	writeFileSync(
		docker,
		`#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *kafka-configs.sh*) [ "\${MOCK_FAIL:-}" != 1 ] || exit 1; printf '  retention.ms=60000\\n  retention.bytes=1000\\n' ;;
  *kafka-get-offsets.sh*earliest*) echo raw:0:10 ;;
  *kafka-get-offsets.sh*latest*)
    if [ "\${MOCK_PROGRESS:-}" = 1 ] && grep -q kafka-consumer-groups.sh "$MOCK_LOG"; then echo raw:0:30; else echo raw:0:20; fi ;;
  *kafka-get-offsets.sh*) echo raw:0:12 ;;
  *kafka-consumer-groups.sh*)
    if [ "\${MOCK_PROGRESS:-}" = 1 ]; then echo 'worker raw 0 25 30 5'; else echo 'worker raw 0 5 20 15'; fi ;;
  *kafka-log-dirs.sh*) echo '{"brokers":[{"logDirs":[{"error":null,"partitions":[{"partition":"raw-0","size":123}]}]}]}' ;;
  *df*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 1000 20 980 2%% /data\\n' ;;
  *) exit 1 ;;
esac
`,
	);
	chmodSync(docker, 0o755);
	try {
		for (const [scenario, status] of [
			["gap", 1],
			["unknown", 2],
			["progress", 0],
		] as const) {
			writeFileSync(log, "");
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					join(import.meta.dir, "kafka-capacity.ts"),
					"--container",
					"fixture",
					"--warn-ms",
					"1000",
					"--format",
					"prometheus",
					"raw=worker",
				],
				{
					env: {
						...process.env,
						PATH: `${directory}:${process.env.PATH}`,
						MOCK_LOG: log,
						MOCK_FAIL: scenario === "unknown" ? "1" : "",
						MOCK_PROGRESS: scenario === "progress" ? "1" : "",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const output = await new Response(child.stdout).text();
			expect(await child.exited).toBe(status);
			expect(output).toContain("recount_kafka_disk_available_bytes 1003520");
			if (scenario === "unknown")
				expect(output).toContain(
					'recount_kafka_capacity_scrape_success{topic="raw",group="worker"} 0',
				);
			else
				expect(output).toContain(
					`recount_kafka_retention_gap{topic="raw",group="worker",partition="0"} ${Number(scenario === "gap")}`,
				);
			expect(readFileSync(log, "utf8")).not.toMatch(
				/--alter|--reset-offsets|--create|--delete/,
			);
		}
	} finally {
		rmSync(directory, { recursive: true });
	}
});
