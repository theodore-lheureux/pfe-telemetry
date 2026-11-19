// Summarizes a campaign run directory into per-phase rows: acknowledgements, freshness,
// throughput, resources, backlog, queries and verification. Usage:
//   bun --no-env-file tests/load/report.ts <run-directory> [--json out.json]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

type Json = Record<string, unknown>;
interface Distribution {
	count: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
}
interface Sample {
	t_ms: number;
	processes: Record<
		string,
		{ pid: number; rss_kib: number; cpu_seconds: number } | undefined
	>;
	lags: { topic: string; lag: number }[];
	clickhouse: {
		active_parts?: number;
		max_parts_in_partition?: number;
		server_memory_tracking?: number;
	} | null;
	containers: { name: string; cpu: string; memory: string }[] | null;
	postgres: { node_table_scans?: number } | null;
}

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { json: { type: "string" } },
});
const run = positionals[0];
if (!run) throw new Error("usage: report.ts <run-directory> [--json out.json]");

const read = (path: string): Json | null =>
	existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const lines = (path: string): Sample[] =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
const round = (value: number, digits = 1) =>
	Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const max = (values: number[]) => (values.length ? Math.max(...values) : null);

function resources(samples: Sample[]) {
	const service = (name: string) => {
		const points = samples
			.map((s) => ({ t: s.t_ms, p: s.processes[name] }))
			.filter((s) => s.p);
		if (points.length < 2) return null;
		// Sum CPU only between samples of the same process, so restarts do not subtract.
		let cpu = 0;
		let seconds = 0;
		for (let i = 1; i < points.length; i++) {
			if (points[i].p?.pid !== points[i - 1].p?.pid) continue;
			cpu +=
				(points[i].p?.cpu_seconds ?? 0) - (points[i - 1].p?.cpu_seconds ?? 0);
			seconds += (points[i].t - points[i - 1].t) / 1000;
		}
		return {
			peak_rss_mib: round(
				(max(points.map((s) => s.p?.rss_kib ?? 0)) ?? 0) / 1024,
			),
			mean_cpu_percent: seconds ? round((cpu / seconds) * 100) : null,
		};
	};
	const containerCpu = (name: string) =>
		max(
			samples.flatMap((s) =>
				(s.containers ?? [])
					.filter((c) => c.name === name)
					.map((c) => Number.parseFloat(c.cpu)),
			),
		);
	const scans = samples
		.map((s) => ({ t: s.t_ms, x: s.postgres?.node_table_scans }))
		.filter((s) => typeof s.x === "number") as { t: number; x: number }[];
	const span =
		scans.length > 1 ? (scans[scans.length - 1].t - scans[0].t) / 1000 : 0;
	// Catch-up after the raw backlog peaked: records per second until it first reached zero.
	const catchUp = (index: number) => {
		const lags = samples.map((s) => ({ t: s.t_ms, lag: s.lags[index]?.lag }));
		const peak = lags.reduce(
			(best, s, i) => ((s.lag ?? 0) > (lags[best].lag ?? 0) ? i : best),
			0,
		);
		const drained = lags.findIndex((s, i) => i > peak && s.lag === 0);
		if (!lags.length || !lags[peak].lag || drained < 0) return null;
		const seconds = (lags[drained].t - lags[peak].t) / 1000;
		return {
			peak: lags[peak].lag,
			seconds: round(seconds),
			records_per_second: round((lags[peak].lag ?? 0) / seconds, 0),
		};
	};
	return {
		raw_catch_up: catchUp(0),
		normalized_catch_up: catchUp(1),
		ingestion: service("IngestionApi"),
		normalizer: service("Normalizer"),
		peak_lag: Object.fromEntries(
			["raw", "normalized", "late"].map((suffix, index) => [
				suffix,
				max(samples.map((s) => s.lags[index]?.lag ?? 0)),
			]),
		),
		peak_active_parts: max(samples.map((s) => s.clickhouse?.active_parts ?? 0)),
		peak_parts_in_partition: max(
			samples.map((s) => s.clickhouse?.max_parts_in_partition ?? 0),
		),
		peak_clickhouse_memory_mib: round(
			(max(samples.map((s) => s.clickhouse?.server_memory_tracking ?? 0)) ??
				0) / 1048576,
		),
		peak_container_cpu_percent: Object.fromEntries(
			(samples[0]?.containers ?? []).map((c) => [c.name, containerCpu(c.name)]),
		),
		credential_lookups_per_minute: span
			? round(((scans[scans.length - 1].x - scans[0].x) / span) * 60, 2)
			: null,
	};
}

function queries(summary: Json | null) {
	const metrics = (summary?.metrics ?? {}) as Record<string, Json>;
	return Object.fromEntries(
		Object.entries(metrics)
			.filter(([name]) => name.startsWith("http_req_duration{query:"))
			.map(([name, value]) => [
				name.slice("http_req_duration{query:".length, -1),
				{
					p50: round(Number(value.med)),
					p95: round(Number(value["p(95)"])),
					max: round(Number(value.max)),
					count: value.count,
				},
			]),
	);
}

/** Seconds from revocation to the first UNAUTHENTICATED request sent afterwards. */
function revocationDelay(directory: string, summary: Json | null) {
	const path = join(directory, "revoke.log");
	const windows = summary?.code_windows_ms as
		| Record<string, [number, number]>
		| undefined;
	if (!existsSync(path) || !windows?.Unauthenticated) return null;
	const revoked = /at_unix_nano=(\d+)/.exec(readFileSync(path, "utf8"))?.[1];
	if (!revoked) return null;
	const rejected =
		Number(summary?.started_unix_nano) / 1e6 + windows.Unauthenticated[0];
	return round((rejected - Number(revoked) / 1e6) / 1000);
}

/** First-attempt latency of requests rejected before publication, such as denied grants. */
function rejectedLatency(directory: string) {
	const path = join(directory, "batches.jsonl");
	// A phase without a summary is still being written.
	if (!existsSync(path) || !existsSync(join(directory, "summary.json")))
		return null;
	const values = readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((b) => !b.probe && b.outcome === "rejected" && b.attempts === 1)
		.map((b) => Number(b.first_ms))
		.sort((a, b) => a - b);
	if (!values.length) return null;
	const rank = (q: number) =>
		values[Math.max(0, Math.ceil(q * values.length) - 1)];
	return {
		count: values.length,
		p50: round(rank(0.5), 3),
		p95: round(rank(0.95), 3),
		p99: round(rank(0.99), 3),
	};
}

function k6Ack(summary: Json | null) {
	const metric = (summary?.metrics as Record<string, Json> | undefined)?.ack_ms;
	if (!metric) return null;
	return { p50: metric.med, p95: metric["p(95)"], count: metric.count };
}

const phases = readdirSync(join(run, "phases")).sort();
const report = phases.map((phase) => {
	const directory = join(run, "phases", phase);
	const summary = read(join(directory, "summary.json"));
	const verify = read(join(directory, "verify.json"));
	const drain = read(join(directory, "drain.json"));
	const k6 = read(join(directory, "k6-summary.json"));
	const distribution = (key: string) => {
		const value = summary?.[key] as Distribution | undefined;
		return value?.count
			? { p50: value.p50, p95: value.p95, p99: value.p99, max: value.max }
			: null;
	};
	return {
		phase,
		offered_per_second: summary
			? round(
					Number(summary.offered_batches) / Number(summary.schedule_seconds),
				)
			: null,
		outcomes: summary?.outcomes ?? null,
		skipped: summary?.skipped_batches ?? null,
		acked_batches_per_second: round(Number(summary?.acked_batches_per_second)),
		acked_samples_per_second: round(
			Number(summary?.acked_samples_per_second),
			0,
		),
		mean_batch_bytes: round(Number(summary?.mean_batch_bytes), 0),
		first_attempt_ms: distribution("first_attempt_ms"),
		acknowledged_ms: distribution("acknowledged_ms"),
		queryable_ms: distribution("probe_visible_ms"),
		queryable_after_ack_ms: distribution("probe_visible_after_ack_ms"),
		load_average: (summary?.host as Json | undefined)?.load_average ?? null,
		k6_ack_ms: k6Ack(k6),
		revocation_delay_seconds: revocationDelay(directory, summary),
		rejected_first_attempt_ms: rejectedLatency(directory),
		drain: drain
			? {
					seconds: round(Number(drain.seconds)),
					initial_lag: (drain.initial as { lag: number }[]).map((l) => l.lag),
				}
			: null,
		resources: resources(lines(join(directory, "resources.jsonl"))),
		queries: queries(read(join(directory, "k6-queries.json"))),
		verify: verify
			? {
					passed: verify.passed,
					expected: verify.expected_samples,
					final: verify.final_rows,
					physical: verify.physical_rows,
					inserted: verify.inserted_rows,
					insert_amplification: round(Number(verify.insert_amplification), 4),
					normalized_amplification: round(
						Number(verify.normalized_amplification),
						4,
					),
					ambiguous_present: verify.ambiguous_present,
					ambiguous_absent: verify.ambiguous_absent,
					rejected: verify.rejected_batches,
					unenrolled_sources: verify.unenrolled_sources,
					divergent: verify.divergent_replicas,
				}
			: null,
	};
});
if (values.json) await Bun.write(values.json, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
