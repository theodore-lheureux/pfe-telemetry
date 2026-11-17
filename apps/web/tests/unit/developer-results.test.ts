import { describe, expect, test } from "bun:test";
import {
	type PublicResultScope,
	parsePublicTaskLine,
	publicTaskOutput,
} from "../../src/developer/public-results.server";

const projectId = "11111111-1111-4111-8111-111111111111";
const createScope: PublicResultScope = {
	action: "create-cpu",
	projectId,
	survey: { DEMO_TTL: "15m" },
};
const loadScope: PublicResultScope = {
	action: "load-cpu",
	projectId,
	survey: {
		DEMO_LAB: "demo-load",
		DEMO_WORKLOAD: "cpu-hash",
		DEMO_DURATION: "60",
	},
};
function line(kind: "CREATE" | "LOAD", value: unknown) {
	return `"msg": "RECOUNT_PUBLIC_${kind} ${Buffer.from(JSON.stringify(value)).toString("base64")}"`;
}
function summary() {
	return {
		job_id: `load-${"a".repeat(32)}`,
		lab_id: "demo-load",
		project_id: projectId,
		cloud: "aws-cpu" as const,
		profile: "cpu-hash" as const,
		duration_seconds: 60,
		state: "completed" as const,
		nodes: [
			{
				name: "demo-load-cpu-0",
				state: "completed" as const,
				elapsed_seconds: 60,
				operations: 10,
				matches: 4,
			},
			{
				name: "demo-load-cpu-1",
				state: "completed" as const,
				elapsed_seconds: 59,
				operations: 20,
				matches: 6,
			},
		],
		reduction: { operations: 30, matches: 10, checksum: "7" },
	};
}
function gpuSummary() {
	return {
		job_id: `load-${"b".repeat(32)}`,
		lab_id: "demo-load",
		project_id: projectId,
		cloud: "gcp-gpu",
		profile: "gpu-mixed",
		duration_seconds: 30,
		state: "running",
		nodes: [
			{
				name: "demo-load-gpu-0",
				state: "running",
				elapsed_seconds: 2.5,
				completed_bursts: 1,
				last_field: 1007,
				exit_code: null,
			},
		],
	};
}

describe("producer public result contract", () => {
	test("accepts complete JSON msg lines, surrounding whitespace and valid SGR colours only", () => {
		const record = line("CREATE", {
			lab_id: "demo-0123456789abcdef",
			ttl: "15m",
		});
		expect(
			parsePublicTaskLine(` \t\x1b[0;32m${record}\x1b[0m \r`, createScope),
		).toEqual({
			kind: "create",
			result: { lab_id: "demo-0123456789abcdef", ttl: "15m" },
		});
		for (const raw of [
			`prefix ${record}`,
			`${record} suffix`,
			`{${record}}`,
			`${record},`,
			record.replace('"msg"', '"other"'),
			record.replace('"msg": "', '"msg": "raw '),
			`\x1b[2K${record}`,
			`\x1b]0;title\x07${record}`,
			`\b${record}`,
			`\x1b[31${record}`,
			"RECOUNT_PUBLIC lab=demo-old",
			"RECOUNT_PUBLIC ttl=15m",
		])
			expect(parsePublicTaskLine(raw, createScope)).toBeNull();
	});
	test("rejects non-canonical or oversized base64 and invalid UTF-8/JSON", () => {
		for (const encoded of [
			"Zg",
			"Zh==",
			"Zg===",
			"Z g==",
			"-_==",
			"/w==",
			Buffer.from("not JSON").toString("base64"),
			Buffer.alloc(65_537, 32).toString("base64"),
		]) {
			expect(
				parsePublicTaskLine(
					`"msg": "RECOUNT_PUBLIC_CREATE ${encoded}"`,
					createScope,
				),
			).toBeNull();
		}
	});
	test("Create matches signed TTL and explicit lab, or the exact generated ID format", () => {
		for (const payload of [
			{ lab_id: "demo-0123456789abcdef", ttl: "30m" },
			{ lab_id: "demo-short", ttl: "15m" },
			{ lab_id: "demo-0123456789ABCDEF", ttl: "15m" },
			{ lab_id: "demo-0123456789abcdef", ttl: "15m", secret: "private" },
		])
			expect(
				parsePublicTaskLine(line("CREATE", payload), createScope),
			).toBeNull();
		const explicit = {
			...createScope,
			survey: { DEMO_TTL: "15m", DEMO_LAB: "manual-lab" },
		};
		expect(
			parsePublicTaskLine(
				line("CREATE", { lab_id: "manual-lab", ttl: "15m" }),
				explicit,
			)?.kind,
		).toBe("create");
		expect(
			parsePublicTaskLine(
				line("CREATE", { lab_id: "other-lab", ttl: "15m" }),
				explicit,
			),
		).toBeNull();
		expect(
			parsePublicTaskLine(
				line("CREATE", { lab_id: "manual-lab", ttl: "15m" }),
				{ ...explicit, action: "configure" },
			),
		).toBeNull();
	});
	test("CPU summary fields and reduction are preserved only for the bound project/lab/fleet/profile", () => {
		expect(parsePublicTaskLine(line("LOAD", summary()), loadScope)).toEqual({
			kind: "load",
			result: summary(),
		});
		for (const changed of [
			{ project_id: "22222222-2222-4222-8222-222222222222" },
			{ lab_id: "other-lab" },
			{ cloud: "gcp-gpu" },
			{ profile: "cpu-primes" },
			{ duration_seconds: 61 },
			{ duration_seconds: 0 },
			{ job_id: "load-invalid" },
			{ state: "running" },
			{ headers: { Authorization: "secret" } },
			{ reduction: { ...summary().reduction, secret: "private" } },
		])
			expect(
				parsePublicTaskLine(
					line("LOAD", { ...summary(), ...changed }),
					loadScope,
				),
			).toBeNull();
		expect(
			parsePublicTaskLine(
				line("LOAD", { ...summary(), duration_seconds: 30 }),
				loadScope,
			)?.kind,
		).toBe("load");
		for (const action of [
			"list",
			"configure",
			"move",
			"destroy",
			"create-cpu",
		] as const)
			expect(
				parsePublicTaskLine(line("LOAD", summary()), { ...loadScope, action }),
			).toBeNull();
	});
	test("all four load actions validate their own signed scope; status/stop may read the current profile", () => {
		for (const action of ["load-status", "stop-load"] as const) {
			const scope = {
				action,
				projectId,
				survey: { DEMO_LAB: "demo-load", DEMO_FLEET: "aws-cpu" },
			};
			expect(
				parsePublicTaskLine(
					line("LOAD", { ...summary(), profile: "cpu-primes" }),
					scope,
				)?.kind,
			).toBe("load");
			expect(
				parsePublicTaskLine(line("LOAD", summary()), {
					...scope,
					survey: { DEMO_LAB: "demo-load", DEMO_FLEET: "gcp-gpu" },
				}),
			).toBeNull();
		}
		const scope: PublicResultScope = {
			action: "load-gpu",
			projectId,
			survey: {
				DEMO_LAB: "demo-load",
				DEMO_WORKLOAD: "gpu-mixed",
				DEMO_DURATION: "60",
			},
		};
		expect(parsePublicTaskLine(line("LOAD", gpuSummary()), scope)?.kind).toBe(
			"load",
		);
		expect(
			parsePublicTaskLine(line("LOAD", gpuSummary()), loadScope),
		).toBeNull();
	});
	test("rejects unknown node data, duplicate nodes, invalid counters and inconsistent reductions", () => {
		const original = summary();
		for (const node of [
			{ ...original.nodes[0], operations: -1 },
			{ ...original.nodes[0], operations: true },
			{ ...original.nodes[0], matches: 11 },
			{ ...original.nodes[0], elapsed_seconds: 331 },
			{ ...original.nodes[0], stderr: "private diagnostics" },
		])
			expect(
				parsePublicTaskLine(
					line("LOAD", { ...original, nodes: [node, original.nodes[1]] }),
					loadScope,
				),
			).toBeNull();
		for (const nodes of [
			[original.nodes[0]],
			[original.nodes[0], original.nodes[0]],
		])
			expect(
				parsePublicTaskLine(line("LOAD", { ...original, nodes }), loadScope),
			).toBeNull();
		for (const reduction of [
			{ ...original.reduction, operations: 31 },
			{ ...original.reduction, matches: 11 },
			{ ...original.reduction, checksum: String(2n ** 64n) },
			{ ...original.reduction, pi_estimate: 3.14 },
		])
			expect(
				parsePublicTaskLine(
					line("LOAD", { ...original, reduction }),
					loadScope,
				),
			).toBeNull();
	});
	test("validates missing/starting/failed checkpoints and pi estimates against the producer reduction", () => {
		const partial = {
			...summary(),
			state: "running",
			nodes: [
				{ name: "a", state: "starting" },
				{ name: "b", state: "missing" },
			],
			reduction: { operations: 0, matches: 0, checksum: "0" },
		};
		expect(parsePublicTaskLine(line("LOAD", partial), loadScope)?.kind).toBe(
			"load",
		);
		const pi = {
			...summary(),
			profile: "cpu-pi",
			reduction: { ...summary().reduction, pi_estimate: (4 * 10) / 30 },
		};
		const scope = {
			...loadScope,
			survey: { DEMO_LAB: "demo-load", DEMO_FLEET: "aws-cpu" },
			action: "load-status" as const,
		};
		expect(parsePublicTaskLine(line("LOAD", pi), scope)?.kind).toBe("load");
		expect(
			parsePublicTaskLine(
				line("LOAD", { ...pi, reduction: { ...pi.reduction, pi_estimate: 4 } }),
				scope,
			),
		).toBeNull();
	});
	test("GPU fields, cardinality, state and exit codes follow the fixed profile", () => {
		const scope: PublicResultScope = {
			action: "load-status",
			projectId,
			survey: { DEMO_LAB: "demo-load", DEMO_FLEET: "gcp-gpu" },
		};
		const original = gpuSummary();
		for (const changed of [
			{ profile: "gpu-memory" },
			{ reduction: { operations: 0 } },
			{ nodes: [...original.nodes, original.nodes[0]] },
			{ nodes: [{ ...original.nodes[0], last_field: 9999 }] },
			{ nodes: [{ ...original.nodes[0], completed_bursts: 1001 }] },
			{ nodes: [{ ...original.nodes[0], exit_code: 256 }] },
		])
			expect(
				parsePublicTaskLine(line("LOAD", { ...original, ...changed }), scope),
			).toBeNull();
		expect(
			parsePublicTaskLine(
				line("LOAD", {
					...original,
					profile: "gpu-memory",
					nodes: [{ ...original.nodes[0], last_field: 1005 }],
				}),
				scope,
			)?.kind,
		).toBe("load");
	});
	test("forwards only canonical validated JSON, rejects mixed identities and never returns raw logs", () => {
		const publicLine = line("LOAD", summary());
		const raw = [
			"Authorization: Bearer secret",
			"<script>bad()</script>",
			publicLine,
			"headers and raw variables",
		];
		expect(JSON.parse(publicTaskOutput(raw, loadScope))).toEqual(summary());
		expect(
			publicTaskOutput(
				[
					...raw,
					line("LOAD", { ...summary(), job_id: `load-${"c".repeat(32)}` }),
				],
				loadScope,
			),
		).toBe("");
		expect(publicTaskOutput(raw, { ...loadScope, action: "list" })).toBe("");
	});
	test("shows recognized Ansible steps without forwarding arbitrary log text", () => {
		const step = "TASK [Apply the saved create plan once] ***************";
		expect(
			publicTaskOutput(
				[
					step,
					"changed: [private-host] => secret",
					"TASK [private-token] ***************",
					`${step} secret`,
					step,
				],
				{ ...loadScope, action: "create-cpu" },
			),
		).toBe("TASK [Apply the saved create plan once]");
	});
});
