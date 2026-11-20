import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { ClickHouseLogLevel, createClient } from "@clickhouse/client";

const execute = promisify(execFile);

const template = () =>
	readFileSync(
		new URL("../../../../infra/clickhouse/schema.sql.in", import.meta.url),
		"utf8",
	);

const withoutComments = (statement: string) =>
	statement
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.trim();

interface Layout {
	pointColumns: string;
	seriesColumns: string;
	pointNames: string;
	seriesNames: string;
	deliveryColumns: string;
	deliveryContextColumns: string;
	streamColumns: string;
	pointSelect: string;
	seriesSelect: string;
	kafkaColumns: string;
}

function storageStatements(layout: Layout) {
	return template()
		.split(";")
		.slice(1, 6)
		.map((statement) =>
			withoutComments(
				statement
					.replace("__CREATE_GUARD____DATABASE__.", "")
					.replace("__POINT_COLUMNS__", layout.pointColumns)
					.replace("__SERIES_COLUMNS__", layout.seriesColumns)
					.replace("__DELIVERY_COLUMNS__", layout.deliveryColumns)
					.replace(
						"__DELIVERY_CONTEXT_COLUMNS__",
						layout.deliveryContextColumns,
					)
					.replace("__STREAM_COLUMNS__", layout.streamColumns),
			),
		);
}

// Synthetic SQL mutations (including generated high-volume rows) rekey their
// dimensions with a fixture-only hash. Production packets carry Rust keys.
function fixtureViews(layout: Layout) {
	const resource =
		"a.path NOT IN ('/recount.host.boot_id', '/recount.collection.epoch_id')";
	const point = "a.path != '/recount.counter.segment_id'";
	const clean = `SELECT * REPLACE (arrayFilter(a -> ${resource}, resource_attributes) AS resource_attributes,
		arrayFilter(a -> ${point}, point_attributes) AS point_attributes) FROM fixture_input`;
	const dimensions = layout.seriesNames
		.split(", ")
		.filter(
			(key) =>
				![
					"series_id",
					"logical_series_id",
					"first_seen_unix_nano",
					"last_seen_unix_nano",
				].includes(key),
		)
		.join(", ");
	const logical = `cityHash64(tuple(project_id,source_id,resource_id,resource_kind,host_id,device_id,scope_name,scope_version,metric_name,unit,
		arraySort(a -> a.path,resource_attributes),arraySort(a -> a.path,scope_attributes),arraySort(a -> a.path,point_attributes)))`;
	const id = `cityHash64(tuple(${dimensions}))`;
	const continuity = (column: string, predicate: string) =>
		`arrayMap(a -> tuple(toUInt32(0), a), arraySort(a -> a.path, arrayFilter(a -> NOT (${predicate}), ${column})))`;
	return [
		`CREATE MATERIALIZED VIEW fixture_deliveries TO deliveries AS
		SELECT project_id, source_id, raw_partition, raw_offset, received_unix_nano, min_event_unix_nano, max_event_unix_nano, delivery_request, delivery_context_id
		FROM fixture_input WHERE notEmpty(delivery_request)`,
		`CREATE MATERIALIZED VIEW fixture_delivery_contexts TO delivery_contexts AS
		SELECT project_id, source_id, delivery_context_id, delivery_context FROM fixture_input WHERE notEmpty(delivery_context)`,
		`CREATE MATERIALIZED VIEW fixture_streams TO metric_streams AS
		SELECT project_id, stream_id,
		${continuity("resource_attributes", resource)} AS resource_continuity,
		${continuity("point_attributes", point)} AS point_continuity FROM fixture_input`,
		`CREATE MATERIALIZED VIEW fixture_series TO metric_series AS
		SELECT ${layout.seriesSelect} FROM (SELECT * REPLACE (${id} AS series_id, ${logical} AS logical_series_id,
		time_unix_nano AS first_seen_unix_nano, time_unix_nano AS last_seen_unix_nano) FROM (${clean})) src`,
		`CREATE MATERIALIZED VIEW fixture_points TO metric_points AS
		SELECT ${layout.pointSelect} FROM (
			SELECT * REPLACE (series_key AS series_id)
			FROM (SELECT *, ${id
				.replace(
					"resource_attributes",
					`arrayFilter(a -> ${resource},resource_attributes)`,
				)
				.replace(
					"point_attributes",
					`arrayFilter(a -> ${point},point_attributes)`,
				)} AS series_key FROM fixture_input)
		) src`,
	];
}

export async function createPointFixture(
	options: { participants?: boolean } = {},
) {
	const url = process.env.RECOUNT_CLICKHOUSE_TEST_URL;
	const executable = process.env.RECOUNT_CONTRACT_FIXTURE;
	if (!url || !executable)
		throw new Error(
			"Disposable ClickHouse URL and host-built RECOUNT_CONTRACT_FIXTURE required",
		);
	const output = async (argument: string) =>
		(
			await execute(executable, [argument], {
				encoding: "buffer",
				timeout: 10_000,
				maxBuffer: 2 * 1024 * 1024,
				env: {},
			})
		).stdout;
	const columns = (await output("--columns")).toString();
	const layout: Layout = JSON.parse(
		(await output("--storage-layout")).toString(),
	);
	const binary = await output("--browser");
	const suffix = randomUUID().replaceAll("-", "");
	const name = `recount_tooling_reader_${suffix}`;
	const readerName = `recount_tooling_reader_${suffix}`;
	const readerPassword = randomUUID();
	const config = {
		url,
		username: process.env.RECOUNT_CLICKHOUSE_TEST_USER ?? "default",
		password: process.env.RECOUNT_CLICKHOUSE_TEST_PASSWORD ?? "",
		log: { level: ClickHouseLogLevel.OFF },
	};
	const admin = createClient(config);
	const client = createClient({
		...config,
		database: name,
		clickhouse_settings: { insert_deduplicate: 0 },
	});
	let created = false;
	let readerCreated = false;
	const readerConfig = {
		...config,
		database: name,
		username: readerName,
		password: readerPassword,
	};
	const reader = createClient(readerConfig);
	async function close() {
		try {
			await Promise.all([reader.close(), client.close()]);
		} finally {
			try {
				if (readerCreated)
					await admin.command({ query: `DROP USER ${readerName}` });
			} finally {
				try {
					if (created)
						await admin.command({ query: `DROP DATABASE ${name} SYNC` });
				} finally {
					await admin.close();
				}
			}
		}
	}
	try {
		await admin.command({ query: `CREATE DATABASE ${name}` });
		created = true;
		for (const query of storageStatements(layout))
			await client.command({ query });
		if (options.participants) {
			const participantColumns = (
				await output("--participant-columns")
			).toString();
			const ddl = readFileSync(
				new URL(
					"../../../../infra/clickhouse/participants.sql.in",
					import.meta.url,
				),
				"utf8",
			)
				.split(";")[0]
				.replace("__DATABASE__.", "")
				.replace("__PARTICIPANT_COLUMNS__", participantColumns.trim());
			await client.command({ query: ddl });
			await client.command({
				query: "SYSTEM STOP MERGES execution_participants",
			});
		}
		await client.command({ query: "SYSTEM STOP MERGES metric_points" });
		await client.command({
			query: `CREATE TABLE fixture (${columns}) ENGINE=Memory`,
		});
		await client.command({
			query: "CREATE TABLE fixture_input AS fixture ENGINE=Null",
		});
		for (const query of fixtureViews(layout)) await client.command({ query });
		const inserted = await client.exec({
			query: "INSERT INTO fixture FORMAT Protobuf",
			values: Readable.from([binary]),
			clickhouse_settings: {
				format_schema: `${process.env.RECOUNT_TEST_METRIC_PROTO ?? "recount.proto"}:AnalyticalPoint`,
				format_protobuf_use_autogenerated_schema: 0,
			},
		});
		inserted.stream.resume();
		await finished(inserted.stream);
		await admin.command({
			// Mirror the telemetry_read profile's constraints so tests reject settings
			// that the deployed reader account would refuse.
			query: `CREATE USER ${readerName} IDENTIFIED WITH sha256_password BY '${readerPassword}'
        SETTINGS max_execution_time = 6 MIN 1 MAX 6, max_threads = 1 MIN 1 MAX 4,
          max_memory_usage = 268435456 MIN 1 MAX 268435456`,
		});
		readerCreated = true;
		for (const table of [
			"metric_points",
			"metric_series",
			"metric_streams",
			"deliveries",
			"delivery_contexts",
			...(options.participants ? ["execution_participants"] : []),
		])
			await admin.command({
				query: `GRANT SELECT ON ${name}.${table} TO ${readerName}`,
			});
		return {
			client,
			reader,
			readerConfig,
			kafkaColumns: layout.kafkaColumns,
			createConnection(options: { username: string; password: string }) {
				return createClient({ ...config, database: name, ...options });
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

export const from = new Date("2026-11-03T10:00:00Z");
export const ns = BigInt(from.getTime()) * 1000000n;
export function scope(
	projectId: string,
	sourceId: string,
	hostId: string | null = "node1",
	duration = 1000,
) {
	return {
		projectId,
		sourceId,
		hostId,
		from,
		to: new Date(from.getTime() + duration),
		buckets: 600,
	};
}

export function stringNode(path: string, value: string) {
	return `tuple('${path}',toUInt8(2),${value},CAST(NULL,'Nullable(Int64)'),CAST(NULL,'Nullable(Float64)'),CAST(NULL,'Nullable(UInt8)'),CAST(NULL,'Nullable(String)'))`;
}

export function insertPoints(
	replacements: Record<string, string> = {},
	tail = "",
) {
	const fields = {
		project_id: "{project:String}",
		source_id: "{source:String}",
		resource_id: "{host:String}",
		host_id: "{host:String}",
		sample_id: "SHA256({sample:String})",
		stream_id: "SHA256({stream:String})",
		time_unix_nano: "{time:UInt64}",
		event_day: "toUInt32(intDiv({time:UInt64},86400000000000))",
		start_time_unix_nano: "toUInt64(0)",
		metric_name: "'recount.node.memory.total'",
		int_value: "CAST({integer:Nullable(String)},'Nullable(Int64)')",
		double_value: "CAST(NULL,'Nullable(Float64)')",
		flags: "toUInt32(0)",
		point_attributes: "[]",
		resource_attributes: `[${stringNode("/host.id", "{host:String}")},${stringNode("/recount.collection.scope", "'node'")},${stringNode("/recount.collection.epoch_id", "{epoch:String}")},${stringNode("/recount.host.boot_id", "{epoch:String}")}]`,
		...replacements,
	};
	return `INSERT INTO fixture_input SELECT seed.* REPLACE (${Object.entries(
		fields,
	)
		.map(([key, value]) => `${value} AS ${key}`)
		.join(",")})
    FROM (SELECT * FROM fixture WHERE metric_name='recount.node.memory.available' AND resource_kind=1) AS seed ${tail}`;
}
