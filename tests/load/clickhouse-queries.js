// Concurrent analytics reads: the web application's compiled statements and settings, sent
// over ClickHouse HTTP as a SELECT-only reader with the telemetry_read profile.

import { check } from "k6";
import encoding from "k6/encoding";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const catalog = JSON.parse(open(__ENV.RECOUNT_LOAD_QUERIES));
const { reader } = JSON.parse(open(__ENV.RECOUNT_LOAD_K6_INPUTS));
const url = __ENV.RECOUNT_LOAD_CLICKHOUSE_URL;
const failures = new Counter("query_failures");
const rows = new Trend("query_rows");
// Per-statement submetrics appear in the summary only when a threshold names them.
const thresholds = {};
for (const query of catalog.queries) {
	thresholds[`http_req_duration{query:${query.name}}`] = ["max>=0"];
	thresholds[`query_rows{query:${query.name}}`] = ["max>=0"];
}

export const options = {
	scenarios: {
		reads: {
			executor: "constant-arrival-rate",
			rate: Number(__ENV.RECOUNT_LOAD_QUERY_RATE || 4),
			timeUnit: "1s",
			duration: __ENV.RECOUNT_LOAD_DURATION || "60s",
			preAllocatedVUs: Number(__ENV.RECOUNT_LOAD_QUERY_VUS || 16),
		},
	},
	summaryTrendStats: ["min", "med", "p(95)", "p(99)", "max", "count"],
	thresholds,
};

function window(query) {
	const toMs = Date.now();
	const fromMs = toMs - query.windowSeconds * 1000;
	const params = {
		...query.params,
		from: `${fromMs}000000`,
		to: `${toMs}000000`,
		firstDay: Math.floor(fromMs / 86400000),
		lastDay: Math.floor((toMs - 1) / 86400000),
	};
	if (query.stepSeconds !== null) {
		params.step = `${query.stepSeconds}000000000`;
		params.seconds = query.stepSeconds;
	}
	return params;
}

function encode(value) {
	if (Array.isArray(value))
		return `[${value.map((item) => `'${item.replaceAll("'", "\\'")}'`).join(",")}]`;
	return String(value);
}

export default function () {
	const queries = catalog.queries;
	const query = queries[exec.scenario.iterationInTest % queries.length];
	const parts = [`database=${catalog.database}`, "default_format=JSONEachRow"];
	for (const [key, value] of Object.entries(window(query)))
		parts.push(`param_${key}=${encodeURIComponent(encode(value))}`);
	for (const [key, value] of Object.entries(query.settings))
		parts.push(`${key}=${encodeURIComponent(String(value))}`);
	const response = http.post(`${url}/?${parts.join("&")}`, query.sql, {
		headers: {
			Authorization: `Basic ${encoding.b64encode(`${reader.user}:${reader.password}`)}`,
		},
		tags: { query: query.name },
		timeout: "15s",
	});
	const ok = check(response, { "query succeeded": (r) => r.status === 200 });
	if (ok)
		rows.add(response.body.split("\n").filter(Boolean).length, {
			query: query.name,
		});
	else {
		failures.add(1, { query: query.name });
		console.error(`${query.name} ${response.status} ${response.body}`);
	}
}
