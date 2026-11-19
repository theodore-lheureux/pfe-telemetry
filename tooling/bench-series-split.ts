import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { compileMeasure } from "../apps/web/src/analytics/compile.server";
import type {
	AnalyticsQuery,
	Measure,
} from "../apps/web/src/analytics/contracts";

const [container, url, fixture, packets] = process.argv.slice(2);
assert(
	container?.startsWith("recount-series-trial-") &&
		url?.startsWith("http://127.0.0.1:") &&
		fixture &&
		packets,
);
const baseline = "c116afd";
const run = `series_trial_${randomBytes(6).toString("hex")}`;
const exec = (args: string[]) => {
	const result = Bun.spawnSync(args, { stderr: "pipe" });
	assert(result.success, result.stderr.toString());
	return result.stdout.toString().trim();
};
const native = (query: string) =>
	exec([
		"docker",
		"exec",
		container,
		"clickhouse-client",
		"--multiquery",
		"--query",
		query,
	]);
const command = (query: string) => native(query);
const layout = JSON.parse(exec([fixture, "--storage-layout"]));
const columns = exec([fixture, "--columns"])
	.split(",\n")
	.slice(0, 51)
	.join(",\n");
const baselineDdl = exec([
	"git",
	"show",
	`${baseline}:infra/clickhouse/schema.sql.in`,
]);
const splitDdl = await Bun.file("infra/clickhouse/schema.sql.in").text();
const baselineCompilerFile = join(
	process.cwd(),
	`apps/web/src/analytics/.${run}.ts`,
);
await Bun.write(
	baselineCompilerFile,
	exec(["git", "show", `${baseline}:apps/web/src/analytics/compile.server.ts`]),
);
const oldCompile = (await import(baselineCompilerFile))
	.compileMeasure as typeof compileMeasure;
const statements = (ddl: string) => ddl.split(";").slice(0, -1);
const project = "synthetic-wire";
const start = 1_797_600_000_000_000_000n;
const to = start + 600_000_000_000n;
const nsToDate = (ns: bigint) => new Date(Number(ns / 1_000_000n));
const window = { projectId: project, from: nsToDate(start), to: nsToDate(to) };
const variants = ["wide1024", "split1024", "split4096"] as const;
const databases = variants.map((variant) => `${run}_${variant}`);
const sourceFiles = readdirSync(packets).sort();
const suites: [
	string,
	string,
	Measure["calculation"],
	"gauge" | "cumulative",
	string[],
	Measure["filters"],
][] = [
	[
		"Node health · processes",
		"recount.collection.discovered.processes",
		"avg",
		"gauge",
		["node"],
		[],
	],
	[
		"Node health · disk read",
		"system.disk.io",
		"rate",
		"cumulative",
		[],
		[{ field: 'attributes["disk.io.direction"]', op: "eq", values: ["read"] }],
	],
	[
		"Node health · disk write",
		"system.disk.io",
		"rate",
		"cumulative",
		[],
		[{ field: 'attributes["disk.io.direction"]', op: "eq", values: ["write"] }],
	],
	[
		"Attribute groups · disk rate",
		"system.disk.io",
		"rate",
		"cumulative",
		['attributes["disk.io.direction"]'],
		[],
	],
	[
		"Execution filter",
		"bench.process.metric.3",
		"avg",
		"gauge",
		["execution"],
		[{ field: "execution", op: "eq", values: ["run:bench"] }],
	],
];

const cpu = () =>
	Number(
		exec(["docker", "exec", container, "cat", "/sys/fs/cgroup/cpu.stat"]).match(
			/usage_usec (\d+)/,
		)?.[1],
	) / 1e6;
const logs = (db: string) => {
	command("SYSTEM FLUSH LOGS system.part_log");
	return JSON.parse(
		native(`SELECT sum(read_rows) AS rows_read, sum(rows) AS rows_written,
		sum(ProfileEvents['UserTimeMicroseconds'] + ProfileEvents['SystemTimeMicroseconds']) / 1e6 AS cpu_s,
		count() AS merges FROM system.part_log WHERE database='${db}'
		AND table != 'execution_participants' AND event_type='MergeParts' FORMAT JSONEachRow`),
	);
};
function parts(db: string) {
	const info =
		native(`SELECT table, sum(rows), sum(bytes_on_disk), count(), groupArray(path)
		FROM system.parts WHERE active AND database='${db}' AND table != 'execution_participants'
		GROUP BY table ORDER BY table FORMAT JSONCompact`).trim();
	return JSON.parse(info).data.map(
		([table, rows, bytes, count, paths]: [
			string,
			string,
			string,
			string,
			string[],
		]) => {
			const files = Number(
				exec([
					"docker",
					"exec",
					container,
					"sh",
					"-c",
					'find "$@" -maxdepth 1 -type f | wc -l',
					"count",
					...paths,
				]),
			);
			return {
				table,
				rows: Number(rows),
				bytes: Number(bytes),
				parts: Number(count),
				files_per_part: files / Number(count),
			};
		},
	);
}

function setup(db: string, wide: boolean, granularity: number) {
	const render = (query: string) =>
		query
			.replaceAll("__DATABASE__", db)
			.replaceAll("__CREATE_GUARD__", "")
			.replaceAll("__ANALYTICAL_COLUMNS__", columns)
			.replaceAll("__POINT_COLUMNS__", layout.pointColumns)
			.replaceAll("__POINT_NAMES__", layout.pointNames)
			.replaceAll("__SERIES_COLUMNS__", layout.seriesColumns)
			.replaceAll("__SERIES_NAMES__", layout.seriesNames)
			.replace(/index_granularity = \d+/, `index_granularity = ${granularity}`);
	const ddl = statements(wide ? baselineDdl : splitDdl);
	const setup = wide
		? [
				...ddl.slice(0, 2),
				`CREATE TABLE ${db}.normalized_kafka (${columns}) ENGINE=Null`,
				ddl[3],
				...ddl.slice(6),
			]
		: [
				...ddl.slice(0, 3),
				ddl[3]
					.replace("__ANALYTICAL_COLUMNS__", exec([fixture, "--columns"]))
					.replace(/ENGINE = Kafka[\s\S]*/, "ENGINE = Null"),
				...ddl.slice(4, 6),
			];
	command(setup.map(render).join(";\n"));
	command(`CREATE TABLE ${db}.execution_participants (
		project_id String, node_id String, process_resource_id Nullable(String), execution_key String,
		first_seen_unix_nano UInt64, last_seen_unix_nano UInt64, ended_unix_nano Nullable(UInt64),
		retracted UInt8, kind UInt8) ENGINE=ReplacingMergeTree ORDER BY (project_id,node_id,execution_key);
		INSERT INTO ${db}.execution_participants VALUES ('${project}', 'node-0', 'proc-0', 'run:bench',${start},${to},NULL,0,2)`);
}

async function measure(db: string, wide: boolean) {
	const tables = [
		"metric_points",
		...(wide
			? ["metric_definitions", "attribute_definitions"]
			: ["metric_series"]),
	];
	for (const table of tables) command(`SYSTEM STOP MERGES ${db}.${table}`);
	const beforeInsert = cpu();
	for (const file of sourceFiles.filter((name) =>
		name.endsWith(wide ? "-wide.pb" : "-split.pb"),
	)) {
		const query = `INSERT INTO ${db}.normalized_kafka SETTINGS format_schema='recount.proto:AnalyticalPoint', format_protobuf_use_autogenerated_schema=0 FORMAT Protobuf`;
		exec([
			"curl",
			"--silent",
			"--show-error",
			"--fail-with-body",
			"--data-binary",
			`@${join(packets, file)}`,
			`${url}/?query=${encodeURIComponent(query)}`,
		]);
	}
	const insert = cpu() - beforeInsert;
	assert.equal(native(`SELECT count() FROM ${db}.metric_points`), "600000");
	if (!wide) {
		assert.equal(
			native(`SELECT count() FROM ${db}.metric_series FINAL WHERE project_id='${project}'
				AND metric_name='recount.collection.discovered.processes' AND last_seen_unix_nano>=${start} AND first_seen_unix_nano<${to}`),
			"1390",
			native(`SELECT project_id, metric_name, min(first_seen_unix_nano), max(last_seen_unix_nano)
				FROM ${db}.metric_series GROUP BY project_id,metric_name LIMIT 20`),
		);
	}
	const beforeMerge = parts(db);
	const before = cpu();
	for (const table of tables) {
		command(
			`SYSTEM START MERGES ${db}.${table}; OPTIMIZE TABLE ${db}.${table} FINAL`,
		);
	}
	return {
		insert_cpu_s: insert,
		merge_container_cpu_s: cpu() - before,
		before_merge: beforeMerge,
		after_merge: parts(db),
		merge_log: logs(db),
	};
}

const quantile = (samples: number[], q: number) =>
	samples.sort((a, b) => a - b)[Math.ceil(q * samples.length) - 1];
async function reads() {
	const clients = databases.map((database) => createClient({ url, database }));
	try {
		const result = {};
		for (const [
			label,
			metric,
			calculation,
			behavior,
			groupBy,
			filters,
		] of suites) {
			const options = {
				shape: "timeseries",
				interval: "1m",
				groupBy,
				filters,
				limit: 25,
			} as AnalyticsQuery;
			const measure = {
				name: "A",
				metric,
				calculation,
				combine: "sum",
			} satisfies Measure;
			const queries = [oldCompile, compileMeasure, compileMeasure].map(
				(compile) =>
					compile(
						options,
						measure,
						{ kind: behavior === "gauge" ? 1 : 2, behavior },
						window,
					),
			);
			const timings = [[], [], []] as number[][];
			let reference: string[] | undefined;
			for (let iteration = 0; iteration < 23; iteration++) {
				for (let order = 0; order < variants.length; order++) {
					const i = (order + iteration) % variants.length;
					const before = performance.now();
					const response = await clients[i].query({
						query: queries[i].sql,
						query_params: queries[i].params,
						format: "JSONEachRow",
						clickhouse_settings: { max_threads: 1 },
					});
					const data = await response.json<Record<string, unknown>>();
					const elapsed = performance.now() - before;
					assert(
						data.length > 0,
						`${label} (${variants[i]}): ${JSON.stringify(queries[i].params)}`,
					);
					// Hash-key order changes Float64 sum order. Compare the complete
					// response after rounding calculation outputs to 12 significant digits.
					const rows = data
						.map((row) =>
							JSON.stringify(row, (key, value) =>
								["series_value", "series_low", "series_high"].includes(key) &&
								typeof value === "number"
									? Number(value.toPrecision(12))
									: value,
							),
						)
						.sort();
					if (reference) assert.deepEqual(rows, reference, label);
					else reference = rows;
					if (iteration >= 3) timings[i].push(elapsed);
				}
			}
			result[label] = Object.fromEntries(
				variants.map((variant, i) => [
					variant,
					{
						result_rows: reference?.length,
						p50_ms: quantile(timings[i], 0.5),
						p95_ms: quantile(timings[i], 0.95),
					},
				]),
			);
		}
		return result;
	} finally {
		await Promise.all(clients.map((client) => client.close()));
	}
}

try {
	const storage = {};
	for (const [i, variant] of variants.entries()) {
		setup(databases[i], i === 0, i === 2 ? 4096 : 1024);
		storage[variant] = await measure(databases[i], i === 0);
		console.error(variant, JSON.stringify(storage[variant]));
	}
	console.log(JSON.stringify({ storage, queries: await reads() }, null, 2));
} finally {
	unlinkSync(baselineCompilerFile);
	for (const db of databases) command(`DROP DATABASE IF EXISTS ${db} SYNC`);
}
