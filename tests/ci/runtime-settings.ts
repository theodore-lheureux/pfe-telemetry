import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

if (process.env.CI !== "true" || !process.env.GITHUB_ENV)
	throw new Error(
		"Runtime settings belong to an explicitly initialized CI job",
	);
const project = process.env.COMPOSE_PROJECT_NAME;
if (
	project !==
	`recount-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
)
	throw new Error("Unexpected CI project");
function output(args: string[]) {
	const result = Bun.spawnSync(["docker", ...args], {
		stdout: "pipe",
		stderr: "inherit",
		timeout: 10_000,
	});
	if (result.exitCode) throw new Error("Owned CI resource discovery failed");
	return result.stdout.toString().trim();
}
const id = output(["compose", "ps", "--quiet", "clickhouse"]);
if (!/^[a-f0-9]{64}$/.test(id))
	throw new Error("Expected one running ClickHouse container");
const identity = output([
	"inspect",
	"--format",
	'{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}',
	id,
]);
if (identity !== `${id}|${project}|clickhouse|true`)
	throw new Error("Foreign ClickHouse container");
const brokerId = output(["compose", "ps", "--quiet", "kafka"]);
if (
	!/^[a-f0-9]{64}$/.test(brokerId) ||
	output([
		"inspect",
		"--format",
		'{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}',
		brokerId,
	]) !== `${brokerId}|${project}|kafka|true`
)
	throw new Error("Foreign Kafka container");
const networks = JSON.parse(
	output(["inspect", "--format", "{{json .NetworkSettings.Networks}}", id]),
);
if (!networks[`${project}_broker`])
	throw new Error("Missing owned broker network");
const allocation = JSON.parse(
	output(["compose", "--profile", "tools", "config", "--format", "json"]),
);
const topics = allocation.services["kafka-topics"].environment as Record<
	string,
	string
>;
const schemaMount = allocation.services.clickhouse.volumes.find(
	(mount: { target: string }) => mount.target === "/etc/recount-schema",
);
if (schemaMount?.type !== "bind")
	throw new Error("Expected selected schema bundle bind");
const schema = await readFile(join(schemaMount.source, "schema.sql"), "utf8");
const pinned = output([
	"exec",
	id,
	"cat",
	"/usr/share/recount-schema/SHA256SUMS",
]);
const hashes = [...pinned.matchAll(/^([a-f0-9]{64}) {2}schema\.sql$/gm)];
if (
	hashes.length !== 1 ||
	hashes[0][1] !== createHash("sha256").update(schema).digest("hex")
)
	throw new Error(
		"Selected schema differs from the running image's pinned schema",
	);
function schemaSetting(name: string) {
	const matches = [
		...schema.matchAll(
			new RegExp(`^\\s*${name} = '([A-Za-z0-9_.-]+)',?$`, "gm"),
		),
	];
	if (matches.length !== 1)
		throw new Error(`Expected one pinned schema setting: ${name}`);
	return matches[0][1];
}
const nativeGroup = schemaSetting("kafka_group_name");
if (schemaSetting("kafka_topic_list") !== topics.RECOUNT_NORMALIZED_TOPIC)
	throw new Error("Schema bundle disagrees with the selected topic allocation");
for (const key of ["RECOUNT_RAW_PARTITIONS", "RECOUNT_NORMALIZED_PARTITIONS"])
	if (!/^[1-9][0-9]*$/.test(String(topics[key])))
		throw new Error("Expected positive selected partition counts");
const settings: Record<string, string | undefined> = {
	RECOUNT_STORAGE_TEST_CONTAINER_ID: id,
	RECOUNT_STORAGE_TEST_COMPOSE_PROJECT: project,
	RECOUNT_STORAGE_TEST_NETWORK: `${project}_broker`,
	RECOUNT_STORAGE_TEST_VERIFIER_PATH:
		"/docker-entrypoint-initdb.d/00-verify-schema.sh",
	RECOUNT_PIPELINE_CLICKHOUSE_CONTAINER_ID: id,
	RECOUNT_PIPELINE_CLICKHOUSE_CONTAINER: output([
		"inspect",
		"--format",
		"{{.Name}}",
		id,
	]).replace(/^\//, ""),
	RECOUNT_PIPELINE_COMPOSE_PROJECT: project,
	RECOUNT_PIPELINE_NETWORK: `${project}_broker`,
	RECOUNT_PIPELINE_DATABASE_NETWORK: `${project}_authority`,
	RECOUNT_PIPELINE_DATABASE_HOST: "postgres",
	RECOUNT_PIPELINE_DATABASE_PORT: "5432",
	RECOUNT_PIPELINE_HOST_ROOT: process.cwd(),
	RECOUNT_PIPELINE_BOOTSTRAP: "kafka:9092",
	RECOUNT_PIPELINE_RAW_TOPIC: topics.RECOUNT_RAW_TOPIC,
	RECOUNT_PIPELINE_NORMALIZED_TOPIC: topics.RECOUNT_NORMALIZED_TOPIC,
	RECOUNT_PIPELINE_NORMALIZER_GROUP: process.env.RECOUNT_NORMALIZER_GROUP,
	RECOUNT_PIPELINE_KAFKA_CONTAINER_ID: brokerId,
	RECOUNT_PIPELINE_NATIVE_GROUP: nativeGroup,
	RECOUNT_PIPELINE_RAW_PARTITIONS: String(topics.RECOUNT_RAW_PARTITIONS),
	RECOUNT_PIPELINE_NORMALIZED_PARTITIONS: String(
		topics.RECOUNT_NORMALIZED_PARTITIONS,
	),
	RECOUNT_RUNTIME_DATABASE_NETWORK: `${project}_authority`,
	RECOUNT_RUNTIME_DATABASE_HOST: "postgres",
	RECOUNT_RUNTIME_DATABASE_PORT: "5432",
};
for (const value of Object.values(settings))
	if (!value || /[\r\n\0]/.test(value))
		throw new Error("Missing or multiline CI setting");
await appendFile(
	process.env.GITHUB_ENV,
	Object.entries(settings)
		.map(([key, value]) => `${key}=${value}\n`)
		.join(""),
);
