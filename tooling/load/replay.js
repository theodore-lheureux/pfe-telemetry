import { check, sleep } from "k6";
import encoding from "k6/encoding";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";
import grpc from "k6/net/grpc";
import { preparePayload } from "./payload.js";

const config = JSON.parse(open(__ENV.RECOUNT_LOAD_CONFIG));
const client = new grpc.Client();
client.loadProtoset(config.descriptor);
const fixtures = Object.fromEntries(
	["idle", "processes"].map((name) => [
		name,
		JSON.parse(open(`./fixtures/${name}.json`)),
	]),
);
const errors = new Rate("otlp_export_errors");
const requests = new Counter("otlp_exports");
const delivered = new Counter("otlp_accepted_points");
const missed = new Counter("otlp_missed_cycles");
const refreshes = new Counter("otlp_token_refreshes");
const refreshErrors = new Counter("otlp_token_refresh_errors");
const targets = config.mode === "regression" ? [1] : [1, 1.5, 2, 3];
export const options = {
	setupTimeout: "10m",
	discardResponseBodies: true,
	thresholds:
		config.mode === "regression"
			? {
					otlp_export_errors: ["rate==0"],
					grpc_req_duration: [`p(95)<${config.p95Ms}`],
					otlp_exports: ["count>0"],
					otlp_missed_cycles: ["count==0"],
					otlp_token_refresh_errors: ["count==0"],
				}
			: { otlp_exports: ["count>0"] },
	scenarios: {
		collectors: {
			executor: "ramping-vus",
			startVUs: 0,
			stages: targets.flatMap((level) => {
				const target = Math.ceil(config.nodes * level);
				return [
					{ duration: config.ramp, target },
					{ duration: config.hold, target },
				];
			}),
			gracefulStop: "4s",
		},
	},
};

function post(path, body) {
	const response = http.post(
		`${config.origin}/api/collectors/${path}`,
		JSON.stringify(body),
		{
			headers: { "Content-Type": "application/json" },
			responseType: "text",
			redirects: 0,
			timeout: "5s",
			tags: { name: `collector/${path}` },
		},
	);
	if (response.status !== 200)
		throw new Error(`Collector ${path}: HTTP ${response.status}`);
	return response.json();
}

export async function setup() {
	const nodes = [];
	const max = Math.ceil(config.nodes * targets.at(-1));
	const enrollmentKey = config.enrollmentKey;
	for (let index = 0; index < max; index++) {
		const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
			"sign",
			"verify",
		]);
		const machineId = `load-${config.runId}-${index + 1}`;
		const issued = post("enroll", {
			enrollmentKey,
			machineId,
			hostname: machineId,
			publicKey: encoding.b64encode(
				await crypto.subtle.exportKey("raw", key.publicKey),
				"rawurl",
			),
		});
		if (issued.projectId !== config.projectId)
			throw new Error("Enrollment returned an unexpected project");
		nodes.push({
			...issued,
			machineId,
			boot: crypto.randomUUID(),
			epoch: crypto.randomUUID(),
			privateKey: encoding.b64encode(
				await crypto.subtle.exportKey("pkcs8", key.privateKey),
				"rawurl",
			),
		});
	}
	console.info(`Enrolled ${nodes.length} nodes for ${config.projectId}`);
	return nodes;
}

let node;
let signing;
let connected = false;
let payload;
let next;
let started;
let renewAt;

async function refresh() {
	signing ??= await crypto.subtle.importKey(
		"pkcs8",
		encoding.b64decode(node.privateKey, "rawurl"),
		{ name: "Ed25519" },
		false,
		["sign"],
	);
	const timestamp = Math.floor(Date.now() / 1000);
	const signature = await crypto.subtle.sign(
		"Ed25519",
		signing,
		new TextEncoder().encode(
			`recount-collector-token\n${node.nodeId}\n${timestamp}`,
		),
	);
	const issued = post("token", {
		nodeId: node.nodeId,
		timestamp,
		signature: encoding.b64encode(signature, "rawurl"),
	});
	if (issued.nodeId !== node.nodeId || issued.projectId !== config.projectId)
		throw new Error("Token returned an unexpected identity");
	node.token = issued.token;
	node.expiresAt = issued.expiresAt;
	refreshes.add(1);
	renewAt = Math.min(
		Date.parse(node.expiresAt) - 60_000,
		Date.now() + config.refreshMs,
	);
}

export default async function (nodes) {
	if (!node) {
		node = nodes[exec.vu.idInTest - 1];
		payload = preparePayload(fixtures[config.fixture], node);
		started = Date.now();
		next = started + Math.floor(Math.random() * 1000);
		renewAt = Math.min(
			Date.parse(node.expiresAt) - 60_000,
			started + config.refreshMs,
		);
	}
	sleep(Math.max(0, next - Date.now()) / 1000);
	const skipped = Math.max(0, Math.floor((Date.now() - next) / 1000));
	missed.add(skipped);
	next += (skipped + 1) * 1000;
	try {
		if (Date.now() >= renewAt) await refresh();
	} catch {
		refreshErrors.add(1);
		renewAt = Date.now() + 5000;
	}
	let result;
	try {
		if (!connected) {
			client.connect(config.target, {
				plaintext: config.plaintext,
				timeout: "3s",
			});
			connected = true;
		}
		const now = Date.now();
		requests.add(1);
		result = client.invoke(
			"opentelemetry.proto.collector.metrics.v1.MetricsService/Export",
			payload.at(now, started),
			{
				timeout: "3s",
				metadata: {
					authorization: `Bearer ${node.token}`,
					"recount-collection-profile": "linux",
					"recount-batch-id": crypto.randomUUID(),
					"recount-batch-created-unix-nano": String(BigInt(now) * 1_000_000n),
				},
			},
		);
	} catch {
		client.close();
		connected = false;
	}
	if (result?.status === grpc.StatusUnauthenticated) renewAt = 0;
	const ok = check(result, {
		"OTLP export accepted": (value) => value?.status === grpc.StatusOK,
	});
	errors.add(!ok);
	if (ok) delivered.add(payload.count);
}
