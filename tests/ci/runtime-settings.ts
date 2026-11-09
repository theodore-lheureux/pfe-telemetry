import { appendFile } from "node:fs/promises";

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
	RECOUNT_PIPELINE_RAW_TOPIC: process.env.RECOUNT_RAW_TOPIC,
	RECOUNT_PIPELINE_NORMALIZED_TOPIC: process.env.RECOUNT_NORMALIZED_TOPIC,
	RECOUNT_PIPELINE_NORMALIZER_GROUP: process.env.RECOUNT_NORMALIZER_GROUP,
	RECOUNT_PIPELINE_KAFKA_CONTAINER_ID: brokerId,
	RECOUNT_PIPELINE_NATIVE_GROUP: "recount-clickhouse",
	RECOUNT_PIPELINE_RAW_PARTITIONS: "3",
	RECOUNT_PIPELINE_NORMALIZED_PARTITIONS: "3",
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
