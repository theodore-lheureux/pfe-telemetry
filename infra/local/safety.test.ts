import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateElf, validateWeb, validateWebRuntime } from "./artifacts";
import { type ComposeConfig, validateData } from "./data";

const owned: string[] = [];
function directory() {
	const path = mkdtempSync(join(tmpdir(), "recount-tooling-"));
	owned.push(path);
	return path;
}
afterEach(() => {
	for (const path of owned.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function config(source: string, bind = false): ComposeConfig {
	return {
		name: "recount-safety-test",
		services: {
			kafka: {
				environment: { RECOUNT_DATA_ID: "synthetic-cluster" },
				volumes: [
					{
						type: bind ? "bind" : "volume",
						source,
						target: "/var/lib/kafka/data",
						bind: { create_host_path: false },
					},
				],
			},
		},
		volumes: { data: { name: "recount-safety-test-data" } },
	};
}

test("data selection rejects ignored binds, missing identity, partial data and nonempty initialization", () => {
	const path = directory();
	const selected = config(path, true);
	expect(() =>
		validateData(
			config("data"),
			{ RECOUNT_KAFKA_DATA_DIRECTORY: path },
			["kafka"],
			"start",
		),
	).toThrow("ignored");
	expect(() => validateData(selected, {}, ["kafka"], "start")).toThrow();
	validateData(selected, {}, ["kafka"], "initialize");
	writeFileSync(
		join(path, "meta.properties"),
		"cluster.id=synthetic-cluster\n",
	);
	validateData(selected, {}, ["kafka"], "start");
	expect(() => validateData(selected, {}, ["kafka"], "initialize")).toThrow(
		"empty",
	);
	selected.services.kafka.environment = {};
	expect(() => validateData(selected, {}, ["kafka"], "start")).toThrow(
		"identity",
	);
	const bind = selected.services.kafka.volumes?.[0].bind;
	if (!bind) throw new Error("Expected synthetic bind fixture");
	bind.create_host_path = true;
	expect(() => validateData(selected, {}, ["kafka"], "inspect")).toThrow(
		"forbidden",
	);
});

test("packaging rejects host binaries, wrong targets and nonexecutable inputs", () => {
	const header = Buffer.alloc(20);
	header.set(Buffer.from("7f454c4602010100", "hex"));
	header.writeUInt16LE(183, 18);
	validateElf(header, 0o755, "arm64");
	expect(() => validateElf(header, 0o755, "amd64")).toThrow();
	expect(() => validateElf(header, 0o644, "arm64")).toThrow();
	expect(() =>
		validateElf(Buffer.from("cffaedfe", "hex"), 0o755, "arm64"),
	).toThrow();
});

test("container data guard refuses replacement initialization and mismatched identity", () => {
	const path = directory();
	const script = join(import.meta.dir, "data-entrypoint.sh");
	const environment = {
		...process.env,
		KAFKA_LOG_DIRS: path,
		RECOUNT_DATA_ID: "expected",
		RECOUNT_INITIALIZE_ROLE: "",
	};
	const run = (initial = false) =>
		Bun.spawnSync(["sh", script, "kafka", "printf", "guard-passed"], {
			env: { ...environment, RECOUNT_INITIALIZE_ROLE: initial ? "kafka" : "" },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 5000,
		});
	expect(run().success).toBe(false);
	expect(run().stdout.toString()).not.toContain("guard-passed");
	expect(run(true).stdout.toString()).toBe("guard-passed");
	writeFileSync(join(path, "meta.properties"), "cluster.id=wrong\nnode.id=1\n");
	mkdirSync(join(path, "__cluster_metadata-0"));
	writeFileSync(
		join(path, "__cluster_metadata-0/000.log"),
		"synthetic metadata",
	);
	expect(run().success).toBe(false);
	expect(run(true).success).toBe(false);
	writeFileSync(
		join(path, "meta.properties"),
		"cluster.id=expected\nnode.id=1\n",
	);
	expect(run().stdout.toString()).toBe("guard-passed");
});

test("runtime staging refuses secrets and escaping symlinks without reading their contents", () => {
	const path = directory();
	const other = directory();
	writeFileSync(join(path, "runtime.mjs"), "export default {};\n");
	validateWeb(path);
	writeFileSync(join(path, ".env.private"), "synthetic only");
	expect(() => validateWeb(path)).toThrow("Private");
	rmSync(join(path, ".env.private"));
	writeFileSync(join(other, "module.js"), "export default {};\n");
	symlinkSync(join(other, "module.js"), join(path, "module.js"));
	expect(() => validateWeb(path)).toThrow("escapes");
});

test("web runtime staging requires built host inputs without owned workspace sources", () => {
	const path = directory();
	expect(() => validateWebRuntime(path)).toThrow();
	mkdirSync(join(path, "server"));
	mkdirSync(join(path, "public"));
	for (const file of ["server/index.mjs", "nitro.json"])
		writeFileSync(join(path, file), "export default {};\n");
	validateWebRuntime(path);
	mkdirSync(join(path, "packages"));
	expect(() => validateWebRuntime(path)).toThrow("must be bundled");
});

test("Compose reuses unchanged services and PostgreSQL waits for TCP readiness", () => {
	const recipes = readFileSync(join(import.meta.dir, "justfile"), "utf8");
	const starts = recipes
		.split("\n")
		.filter((line) => line.includes("docker compose up "));
	expect(starts).toHaveLength(3);
	for (const start of starts) {
		expect(start).toContain("up --no-build --no-deps");
		expect(start).not.toContain("--no-recreate");
		expect(start).not.toContain("--force-recreate");
	}
	expect(readFileSync(join(import.meta.dir, "compose.yaml"), "utf8")).toContain(
		"pg_isready --host=127.0.0.1 --username=recount --dbname=recount",
	);
});

test("finite initialization stops only its owned one-off and never retries partial state", async () => {
	const path = directory();
	const log = join(path, "calls.jsonl");
	const created = join(path, "created");
	writeFileSync(
		join(path, "docker"),
		`#!/bin/sh\nexec '${process.execPath}' --no-env-file '${join(path, "docker.ts")}' "$@"\n`,
	);
	chmodSync(join(path, "docker"), 0o755);
	writeFileSync(
		join(path, "docker.ts"),
		`
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_LOG!, JSON.stringify(args) + "\\n");
if (args[0] === "compose" && args[1] === "config") console.log(process.env.MOCK_CONFIG);
else if (args[0] === "volume") process.exit(1);
else if (args[0] === "compose" && args.includes("--detach")) {
  if (process.env.MOCK_CASE === "failed-absent") process.exit(17);
  if (process.env.MOCK_CASE === "missing") process.exit(0);
  writeFileSync(process.env.MOCK_CREATED!, "synthetic container");
  if (process.env.MOCK_CASE === "interrupted") await Bun.sleep(30_000);
  if (["failed-present", "failed-cleanup"].includes(process.env.MOCK_CASE!)) process.exit(17);
}
else if (args[0] === "container" && args[1] === "inspect") {
  if (!existsSync(process.env.MOCK_CREATED!)) process.exit(1);
  console.log(JSON.stringify([{State: {Running: true, Health: {Status: process.env.MOCK_CASE === "unhealthy" ? "unhealthy" : "healthy"}}}]));
}
else if (args[0] === "stop" && process.env.MOCK_CASE === "failed-cleanup") process.exit(43);
else if (args.includes("--identity")) console.log("synthetic-cluster");
`,
	);
	for (const scenario of [
		"healthy",
		"unhealthy",
		"failed-present",
		"failed-absent",
		"failed-cleanup",
		"interrupted",
		"missing",
	]) {
		writeFileSync(log, "");
		rmSync(created, { force: true });
		const child = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				join(import.meta.dir, "initialize.ts"),
				"kafka",
			],
			{
				cwd: path,
				env: {
					...process.env,
					PATH: `${path}:${process.env.PATH}`,
					MOCK_LOG: log,
					MOCK_CONFIG: JSON.stringify(config("data")),
					MOCK_CASE: scenario,
					MOCK_CREATED: created,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const completed = Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (scenario === "interrupted") {
			const deadline = Date.now() + 2000;
			while (!existsSync(created) && Date.now() < deadline) await Bun.sleep(10);
			child.kill("SIGTERM");
			expect(existsSync(created)).toBe(true);
		}
		const [status, output, errors] = await completed;
		expect(status).toBe(scenario === "healthy" ? 0 : 1);
		const calls: string[][] = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const creation = calls.filter((args) => args.includes("--detach"));
		expect(creation).toHaveLength(1);
		expect(creation[0]).toContain("--use-aliases");
		const name = creation[0][creation[0].indexOf("--name") + 1];
		expect(calls.filter((args) => args[0] === "stop")).toEqual(
			["failed-absent", "missing"].includes(scenario)
				? []
				: [["stop", "--time", "60", name]],
		);
		for (const inspected of calls.filter(
			(args) => args[0] === "container" && args[1] === "inspect",
		))
			expect(inspected[2]).toBe(name);
		expect(
			calls.some(
				(args) =>
					args.includes("down") ||
					args.includes("--volumes") ||
					args.includes("--reset-offsets"),
			),
		).toBe(false);
		if (scenario === "healthy")
			expect(output).toContain("RECOUNT_KAFKA_DATA_ID=synthetic-cluster");
		else {
			expect(
				calls.some((args) => args[0] === "rm" || args.includes("--identity")),
			).toBe(false);
			expect(output).not.toContain("RECOUNT_KAFKA_DATA_ID=");
		}
		if (scenario.startsWith("failed-"))
			expect(errors).toContain("Initialization creation failed (17)");
		if (scenario === "interrupted")
			expect(errors).toContain("Initialization interrupted during creation");
	}
});

test("topic verification never creates or repairs topics; creation is explicit", async () => {
	const path = directory();
	const log = join(path, "kafka-calls");
	const tool = join(path, "tool.sh");
	writeFileSync(
		tool,
		`#!/bin/bash\nprintf '%s\\n' "$*" >> "$MOCK_LOG"\ncase "$*" in\n*--describe*--topic*) [ "\${MOCK_MISSING:-}" != 1 ] || exit 1; echo 'PartitionCount: 3 ReplicationFactor: 1' ;;\n*--entity-type*) echo 'retention.ms=100 retention.bytes=100 segment.bytes=100 segment.ms=100 max.message.bytes=100 cleanup.policy=delete min.insync.replicas=1 unclean.leader.election.enable=false ' ;;\nesac\n`,
	);
	chmodSync(tool, 0o755);
	symlinkSync(tool, join(path, "kafka-topics.sh"));
	symlinkSync(tool, join(path, "kafka-configs.sh"));
	const source = readFileSync(
		join(import.meta.dir, "../kafka/init-topics.sh"),
		"utf8",
	).replace("tool=/opt/kafka/bin", `tool='${path}'`);
	const script = join(path, "topics.sh");
	writeFileSync(script, source);
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		MOCK_LOG: log,
		RECOUNT_KAFKA_BOOTSTRAP: "synthetic:9092",
		RECOUNT_RAW_TOPIC: "raw",
		RECOUNT_NORMALIZED_TOPIC: "normalized",
		RECOUNT_RAW_PARTITIONS: "3",
		RECOUNT_NORMALIZED_PARTITIONS: "3",
		RECOUNT_BROKER_MESSAGE_BYTES: "100",
		RECOUNT_BROKER_FETCH_BYTES: "100",
	};
	for (const prefix of ["RAW", "NORMALIZED"])
		for (const suffix of [
			"RETENTION_MS",
			"RETENTION_BYTES",
			"SEGMENT_BYTES",
			"SEGMENT_MS",
			"BROKER_MAX_BYTES",
		])
			env[`RECOUNT_${prefix}_${suffix}`] = "100";
	for (const [mode, missing] of [
		["verify", ""],
		["verify", "1"],
		["create", ""],
	]) {
		writeFileSync(log, "");
		const child = Bun.spawn(["bash", script, mode], {
			env: { ...env, MOCK_MISSING: missing },
			stdout: "ignore",
			stderr: "pipe",
		});
		expect(await child.exited).toBe(missing ? 1 : 0);
		const calls = readFileSync(log, "utf8");
		expect(calls.includes("--create")).toBe(mode === "create");
		expect(calls.includes("--alter") || calls.includes("--reset-offsets")).toBe(
			false,
		);
	}
});

test("resolved Compose preserves owner defaults and propagates only allowlisted overrides", () => {
	const path = directory();
	const empty = join(path, "empty.env");
	const custom = join(path, "custom.env");
	writeFileSync(empty, "");
	const overrides = {
		RECOUNT_MAX_REQUEST_BYTES: "7000000",
		RECOUNT_MAX_POINTS: "17",
		RECOUNT_MAX_EXPANDED_ITEMS: "300000",
		RECOUNT_MAX_AUTHORITIES: "300",
		RECOUNT_MAX_ATTRIBUTE_NODES: "100",
		RECOUNT_NORMALIZED_MAX_RECORD_BYTES: "2000000",
		RECOUNT_NORMALIZED_MAX_OUTPUT_BYTES: "19000000",
		RECOUNT_RAW_BROKER_MAX_BYTES: "7065536",
		RECOUNT_NORMALIZED_BROKER_MAX_BYTES: "2065536",
		RECOUNT_NORMALIZER_OUTPUT_ROWS: "64",
		RECOUNT_NORMALIZER_MAX_ACTIVE: "3",
		RECOUNT_NORMALIZER_RETRY_MS: "1100",
		RECOUNT_NORMALIZER_DELIVERY_MS: "12000",
		RECOUNT_NORMALIZER_SHUTDOWN_MS: "16000",
		RECOUNT_INGESTION_MAX_IN_FLIGHT: "2",
		RECOUNT_BROKER_MESSAGE_BYTES: "9000000",
		RECOUNT_BROKER_FETCH_BYTES: "11000000",
		RECOUNT_BROKER_REQUEST_BYTES: "13000000",
		RECOUNT_KAFKA_RECEIVE_BYTES: "12582912",
		RECOUNT_UNRELATED_SECRET: "must-not-propagate",
	};
	writeFileSync(
		custom,
		Object.entries(overrides)
			.map(([key, value]) => `${key}=${value}\n`)
			.join(""),
	);
	const resolve = (envFile: string, extra: Record<string, string> = {}) => {
		const result = Bun.spawnSync(
			[
				"docker",
				"compose",
				"--env-file",
				envFile,
				"--file",
				join(import.meta.dir, "compose.yaml"),
				"--file",
				join(import.meta.dir, "compose.apps.yaml"),
				"config",
				"--format",
				"json",
			],
			{
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					POSTGRES_PASSWORD: "synthetic-postgres",
					CLICKHOUSE_ADMIN_PASSWORD: "synthetic-admin",
					CLICKHOUSE_READER_PASSWORD: "synthetic-reader",
					RECOUNT_INGESTION_DATABASE_URL: "synthetic-ingestion",
					DATABASE_URL: "synthetic-web",
					BETTER_AUTH_SECRET: "synthetic-auth",
					...extra,
				},
				stdout: "pipe",
				stderr: "pipe",
				timeout: 15000,
			},
		);
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		return JSON.parse(result.stdout.toString()).services as Record<
			string,
			{
				environment: Record<string, string | null>;
				volumes?: { source: string; target: string }[];
			}
		>;
	};
	const omitted = resolve(empty);
	for (const key of Object.keys(overrides).filter(
		(key) =>
			key.startsWith("RECOUNT_MAX_") ||
			key.startsWith("RECOUNT_NORMALIZED_MAX_"),
	)) {
		expect(omitted["ingestion-api"].environment[key]).toBeNull();
		expect(omitted.normalizer.environment[key]).toBeNull();
	}
	expect(
		omitted.normalizer.environment.RECOUNT_NORMALIZER_OUTPUT_ROWS,
	).toBeUndefined();
	const selected = resolve(custom);
	for (const [key, value] of Object.entries(overrides)) {
		if (
			key.startsWith("RECOUNT_MAX_") ||
			key.startsWith("RECOUNT_NORMALIZED_MAX_") ||
			key === "RECOUNT_RAW_BROKER_MAX_BYTES"
		) {
			expect(selected["ingestion-api"].environment[key]).toBe(value);
			expect(selected.normalizer.environment[key]).toBe(value);
		}
		if (key.startsWith("RECOUNT_NORMALIZER_")) {
			if (key === "RECOUNT_NORMALIZER_OUTPUT_ROWS") {
				expect(selected.normalizer.environment[key]).toBeUndefined();
			} else {
				expect(selected.normalizer.environment[key]).toBe(value);
			}
			expect(selected["ingestion-api"].environment[key]).toBeUndefined();
		}
	}
	expect(
		selected.clickhouse.environment.RECOUNT_NORMALIZED_BROKER_MAX_BYTES,
	).toBe("2065536");
	expect(selected.clickhouse.environment.RECOUNT_NORMALIZER_OUTPUT_ROWS).toBe(
		"64",
	);
	expect(selected.clickhouse.environment.RECOUNT_KAFKA_RECEIVE_BYTES).toBe(
		"12582912",
	);
	expect(
		selected.normalizer.environment.RECOUNT_KAFKA_RECEIVE_BYTES,
	).toBeUndefined();
	expect(
		selected["ingestion-api"].environment.RECOUNT_KAFKA_RECEIVE_BYTES,
	).toBeUndefined();
	expect(selected.kafka.environment.KAFKA_MESSAGE_MAX_BYTES).toBe("9000000");
	expect(selected.kafka.environment.KAFKA_REPLICA_FETCH_MAX_BYTES).toBe(
		"11000000",
	);
	expect(selected.kafka.environment.KAFKA_SOCKET_REQUEST_MAX_BYTES).toBe(
		"13000000",
	);
	expect(
		selected["ingestion-api"].environment.RECOUNT_INGESTION_MAX_IN_FLIGHT,
	).toBe("2");
	expect(
		resolve(custom, { RECOUNT_MAX_POINTS: "23" }).normalizer.environment
			.RECOUNT_MAX_POINTS,
	).toBe("23");
	expect(
		resolve(custom, { RECOUNT_MAX_POINTS: "" }).normalizer.environment
			.RECOUNT_MAX_POINTS,
	).toBe("");
	for (const service of Object.values(selected)) {
		expect(service.environment.RECOUNT_UNRELATED_SECRET).toBeUndefined();
		expect(service.environment.RECOUNT_NORMALIZED_FETCH_BYTES).toBeUndefined();
	}
	expect(
		selected.normalizer.environment.RECOUNT_INGESTION_DATABASE_URL,
	).toBeUndefined();
	expect(selected.normalizer.environment.CLICKHOUSE_PASSWORD).toBeUndefined();
	expect(
		resolve(join(import.meta.dir, ".env.example")).normalizer.environment
			.RECOUNT_MAX_POINTS,
	).toBeNull();
	expect(
		selected.clickhouse.volumes?.some(
			(mount) =>
				mount.target === "/etc/clickhouse-server/config.d/native-transport.xml",
		),
	).toBe(true);
});
