// OTLP gRPC ingestion ramp with signed node tokens. Each batch is logged as
// `ACK <node> <batch> <points>` or `NACK <node> <batch> <points> <status>`, so
// `recount-pipeline-load verify` can derive its identities.

import { check } from "k6";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";
import grpc from "k6/net/grpc";

const inputs = JSON.parse(open(__ENV.RECOUNT_LOAD_K6_INPUTS));
const label = __ENV.RECOUNT_LOAD_LABEL;
const points = Number(__ENV.RECOUNT_LOAD_POINTS || 16);
const stages = JSON.parse(
	__ENV.RECOUNT_LOAD_STAGES ||
		'[{"target":20,"duration":"30s"},{"target":20,"duration":"30s"}]',
);
const client = new grpc.Client();
client.loadProtoset(__ENV.RECOUNT_LOAD_PROTOSET);
const acknowledged = new Trend("ack_ms", true);
const outcomes = new Counter("export_outcomes");
let connected = false;

if (!/^[A-Za-z0-9_-]+$/.test(label || ""))
	throw new Error("RECOUNT_LOAD_LABEL must be a fresh phase label");

export const options = {
	scenarios: {
		ramp: {
			executor: "ramping-arrival-rate",
			startRate: 1,
			timeUnit: "1s",
			preAllocatedVUs: Number(__ENV.RECOUNT_LOAD_VUS || 64),
			stages,
		},
	},
	summaryTrendStats: ["min", "med", "p(95)", "p(99)", "max", "count"],
};

function body(createdMs) {
	const dataPoints = [];
	for (let p = 0; p < points; p++)
		dataPoints.push({
			timeUnixNano: `${createdMs - (points - 1 - p)}000000`,
			asDouble: p,
			attributes: [{ key: "load.series", value: { stringValue: `s${p % 4}` } }],
		});
	return {
		resourceMetrics: [
			{
				resource: {
					attributes: [{ key: "service.name", value: { stringValue: "k6" } }],
				},
				scopeMetrics: [
					{
						scope: { name: "recount-load-k6" },
						metrics: [{ name: "load.k6", unit: "1", gauge: { dataPoints } }],
					},
				],
			},
		],
	};
}

export default function () {
	if (!connected) {
		client.connect(inputs.address, { plaintext: true, timeout: "5s" });
		connected = true;
	}
	const node = inputs.nodes[exec.vu.idInTest % inputs.nodes.length];
	const batch = `${label}-${exec.scenario.iterationInTest}`;
	const createdMs = Date.now();
	const started = Date.now();
	const response = client.invoke(
		"opentelemetry.proto.collector.metrics.v1.MetricsService/Export",
		body(createdMs),
		{
			metadata: {
				authorization: `Bearer ${node.token}`,
				"recount-batch-id": batch,
				"recount-batch-created-unix-nano": `${createdMs}000000`,
			},
			timeout: "10s",
		},
	);
	const ok = response.status === grpc.StatusOK;
	outcomes.add(1, { status: String(response.status) });
	check(response, { acknowledged: () => ok });
	if (ok) {
		acknowledged.add(Date.now() - started);
		console.log(`ACK ${node.index} ${batch} ${points}`);
	} else {
		// Unacknowledged batches are not retried; some may still have been published.
		console.log(`NACK ${node.index} ${batch} ${points} ${response.status}`);
	}
}
