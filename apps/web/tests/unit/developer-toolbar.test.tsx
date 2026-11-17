import { describe, expect, test } from "bun:test";
import { paraglideMiddleware } from "@recount/i18n/server";
import { renderToStaticMarkup } from "react-dom/server";
import { withActor } from "../../src/auth/actor.server";
import {
	configuredLabGrant,
	isDeveloper,
	semaphoreConfiguration,
} from "../../src/developer/config.server";
import {
	parseWorkflow,
	playbooks,
	survey,
	type WorkflowAction,
} from "../../src/developer/contracts";
import {
	type DeveloperDependencies,
	developerOperations,
} from "../../src/developer/developer.server";
import { publicTaskOutput } from "../../src/developer/public-results.server";
import {
	Semaphore,
	taskScopeMessage,
} from "../../src/developer/semaphore.server";
import { TaskStatus } from "../../src/developer/task-status";
import { DeveloperToolbar } from "../../src/developer/toolbar";
import { ttlLabels } from "../../src/developer/workflow-labels";
import { OperationError } from "../../src/lib/operation-error";
import { nativeSurvey } from "./developer-template-fixtures";

const reference = {
	organizationId: "org-one",
	projectId: "11111111-1111-4111-8111-111111111111",
};
const otherProject = "22222222-2222-4222-8222-222222222222";
const config = {
	baseUrl: "https://semaphore.invalid",
	uiUrl: "https://semaphore-ui.invalid",
	projectId: 7,
	token: "private-api-token",
	gpuEnabled: false,
};
const template = {
	id: 4,
	project_id: 7,
	app: "ansible",
	playbook: "infra/demo/create-cpu.yml",
	environment_ids: [9],
	arguments: "[]",
};
const group = {
	id: 9,
	project_id: 7,
	json: "{}",
	env: JSON.stringify({
		DEMO_PROJECT_ID: reference.projectId,
		DEMO_PROJECT: "test",
	}),
	secrets: [
		{ name: "DEMO_ENROLLMENT_KEY", type: "env", secret: "never-return-this" },
	],
};
const task = {
	id: 20,
	template_id: 4,
	project_id: 7,
	status: "running" as const,
	created: "2026-11-17T12:00:00Z",
	environment: "{}",
	message: taskScopeMessage(
		config.token,
		reference.projectId,
		4,
		"{}",
		"create-cpu",
	),
};
function input(overrides = {}) {
	return parseWorkflow({
		...reference,
		action: "create-cpu",
		confirmed: true,
		...overrides,
	});
}
function upstream(overrides: Record<string, unknown> = {}) {
	const calls: { path: string; init?: RequestInit }[] = [];
	const routes: Record<string, unknown> = {
		templates: [template],
		"environment/9": group,
		"tasks/last?count=30": [task],
		tasks: task,
		"tasks/20": task,
		"tasks/20/output": [
			{ output: "Authorization: Bearer private-api-token" },
			{ output: "RECOUNT_PUBLIC ttl=15m" },
		],
		...overrides,
	};
	if (Array.isArray(routes.templates))
		routes.templates = routes.templates.map((entry) => {
			const action = (Object.keys(playbooks) as WorkflowAction[]).find(
				(key) => playbooks[key] === entry.playbook,
			);
			return action && !Object.hasOwn(entry, "survey_vars")
				? { ...entry, survey_vars: nativeSurvey(action) }
				: entry;
		});
	const transport = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		const path = String(url).split("/api/project/7/")[1];
		calls.push({ path, init });
		const value = routes[path];
		if (value instanceof Response) return value;
		if (value instanceof Error) throw value;
		return Response.json(value);
	}) as typeof fetch;
	return { calls, connector: new Semaphore(config, transport) };
}
const database = {} as Parameters<DeveloperDependencies["authorize"]>[0];
const actor = { id: "theodore-id" };
function operations(
	connector: Semaphore,
	changes: Partial<DeveloperDependencies> = {},
) {
	const authorizations: unknown[] = [];
	const api = developerOperations({
		allowed: (id) => id === actor.id,
		authorize: async (_db, _actor, ref, permission) => {
			authorizations.push({ ...ref, permission });
		},
		connector: () => connector,
		labGrant: () => ({ ...reference, fleet: "aws-cpu" }),
		...changes,
	});
	return { api, authorizations };
}

describe("developer boundary", () => {
	test("disabled by default; explicit IDs only, never email or environment mode", () => {
		expect(isDeveloper(actor.id, {})).toBe(false);
		expect(
			isDeveloper(actor.id, {
				RECOUNT_DEVELOPER_USER_IDS: `other, ${actor.id}`,
			}),
		).toBe(true);
		expect(
			isDeveloper("theodore@example.invalid", {
				RECOUNT_DEVELOPER_USER_IDS: actor.id,
			}),
		).toBe(false);
		expect(semaphoreConfiguration({})).toBeNull();
		expect(
			semaphoreConfiguration({
				RECOUNT_SEMAPHORE_URL: "http://unsafe.invalid",
				RECOUNT_SEMAPHORE_PROJECT_ID: "7",
				RECOUNT_SEMAPHORE_TOKEN: "x",
			}),
		).toBeNull();
		expect(
			configuredLabGrant("demo-test", {
				RECOUNT_DEVELOPER_LAB_GRANTS: "invalid",
			}),
		).toBeNull();
	});
	test("ordinary users receive no capability and cannot invoke any upstream operation", async () => {
		const { connector, calls } = upstream();
		const { api } = operations(connector);
		const user = { id: "organization-owner" };
		expect(await api.capability(database as never, user, reference)).toBeNull();
		await expect(api.recent(database, user, reference)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(api.run(database, user, input())).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			api.output(database, user, { ...reference, taskId: 20 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(calls).toHaveLength(0);
	});
	test("anonymous identity never enters domain operations", async () => {
		const { connector, calls } = upstream();
		const { api } = operations(connector);
		const result = await withActor(
			{ data: null, error: { code: "UNAUTHENTICATED", message: "Sign in" } },
			(user) => api.run(database, user, input()),
		);
		expect(result.error?.code).toBe("UNAUTHENTICATED");
		expect(calls).toHaveLength(0);
	});
	test("every developer operation independently checks canonical project access", async () => {
		const { connector, calls } = upstream();
		const { api, authorizations } = operations(connector, {
			authorize: async () => {
				throw new OperationError("NOT_FOUND", "Project not found");
			},
		});
		for (const run of [
			() => api.recent(database, actor, reference),
			() => api.run(database, actor, input()),
			() => api.output(database, actor, { ...reference, taskId: 20 }),
		])
			await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(authorizations).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});
	test("capability is null for allowlisted users without project administration and does not contact Semaphore", async () => {
		for (const code of ["FORBIDDEN", "NOT_FOUND"] as const) {
			const { connector, calls } = upstream();
			const { api } = operations(connector, {
				authorize: async () => {
					throw new OperationError(code, "Project inaccessible");
				},
			});
			expect(
				await api.capability(database as never, actor, reference),
			).toBeNull();
			expect(calls).toHaveLength(0);
		}
	});
	test("existing lab operations require a server grant and source authorization", async () => {
		const { connector, calls } = upstream();
		const { api } = operations(connector, { labGrant: () => null });
		await expect(
			api.run(database, actor, input({ action: "destroy", lab: "demo-test" })),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(calls).toHaveLength(0);
		const moved = operations(connector, {
			labGrant: () => ({
				organizationId: "source",
				projectId: otherProject,
				fleet: "aws-cpu",
			}),
			authorize: async (_db, _actor, ref) => {
				if (ref.organizationId === "source")
					throw new OperationError("NOT_FOUND", "Project not found");
			},
		});
		await expect(
			moved.api.run(
				database,
				actor,
				input({ action: "move", lab: "demo-test" }),
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(calls).toHaveLength(0);
	});
	test("all load operations reject missing or cross-project lab grants before upstream calls", async () => {
		for (const action of [
			"load-cpu",
			"load-gpu",
			"load-status",
			"stop-load",
		] as const) {
			for (const grant of [
				null,
				{ ...reference, projectId: otherProject, fleet: "aws-cpu" as const },
			]) {
				const { connector, calls } = upstream();
				const { api } = operations(connector, { labGrant: () => grant });
				await expect(
					api.run(database, actor, input({ action, lab: "demo-load" })),
				).rejects.toMatchObject({ code: "NOT_FOUND" });
				expect(calls).toHaveLength(0);
			}
		}
	});
	test("no developer rendering when capability is absent or injected as false", () => {
		expect(
			renderToStaticMarkup(
				<DeveloperToolbar
					userId="ordinary"
					reference={reference}
					capability={null}
				/>,
			),
		).toBe("");
		expect(
			renderToStaticMarkup(
				<DeveloperToolbar
					userId="ordinary"
					reference={reference}
					capability={{ enabled: false } as never}
				/>,
			),
		).toBe("");
		expect(
			renderToStaticMarkup(
				<DeveloperToolbar
					userId={actor.id}
					reference={reference}
					capability={{ enabled: true, gpuEnabled: false }}
				/>,
			),
		).toContain("Recount");
	});
	test("developer entry point renders from the request's compiled French catalog", async () => {
		const response = await paraglideMiddleware(
			new Request("https://recount.invalid", {
				headers: { cookie: "recount_locale=fr" },
			}),
			() =>
				new Response(
					renderToStaticMarkup(
						<DeveloperToolbar
							userId={actor.id}
							reference={reference}
							capability={{ enabled: true, gpuEnabled: false }}
						/>,
					),
				),
		);
		expect(await response.text()).toContain("Développeur");
	});
	test("activity statuses and TTL choices use the request locale", async () => {
		const response = await paraglideMiddleware(
			new Request("https://recount.invalid", {
				headers: { cookie: "recount_locale=fr" },
			}),
			() =>
				Response.json({
					status: renderToStaticMarkup(<TaskStatus status="running" />),
					ttls: ttlLabels(),
				}),
		);
		const data = await response.json();
		expect(data.status).toContain("En cours");
		expect(data.ttls["15m"]).toBe("15 minutes");
		expect(data.ttls["1h"]).toMatch(/^1\sheure$/);
		expect(data.ttls["2h"]).toMatch(/^2\sheures$/);
	});
});

describe("survey allowlist", () => {
	test("load starts accept only fixed profiles and bounded integer durations without fleet overrides", () => {
		for (const workload of ["cpu-hash", "cpu-primes", "cpu-pi"])
			expect(
				survey(
					input({
						action: "load-cpu",
						lab: "demo-load",
						workload,
						duration: "300",
					}),
				),
			).toEqual({
				DEMO_LAB: "demo-load",
				DEMO_WORKLOAD: workload,
				DEMO_DURATION: "300",
			});
		for (const workload of [
			"gpu-fp32",
			"gpu-tensor",
			"gpu-memory",
			"gpu-mixed",
		])
			expect(
				survey(
					input({
						action: "load-gpu",
						lab: "demo-load",
						workload,
						duration: "1",
					}),
				),
			).toEqual({
				DEMO_LAB: "demo-load",
				DEMO_WORKLOAD: workload,
				DEMO_DURATION: "1",
			});
		expect(
			survey(input({ action: "load-gpu", lab: "demo-load" })).DEMO_WORKLOAD,
		).toBe("gpu-mixed");
		for (const duration of ["0", "301", "1.5", "-1", "01", "1;id"])
			expect(() =>
				input({ action: "load-cpu", lab: "demo-load", duration }),
			).toThrow();
		for (const action of ["load-cpu", "load-gpu"])
			expect(() =>
				input({ action, lab: "demo-load", fleet: "aws-cpu" }),
			).toThrow();
		expect(() =>
			input({ action: "load-cpu", lab: "demo-load", workload: "gpu-mixed" }),
		).toThrow();
		expect(() =>
			input({ action: "load-gpu", lab: "demo-load", workload: "cpu-pi" }),
		).toThrow();
		for (const extra of [
			{ command: "id" },
			{ workerCount: "2" },
			{ environment: {} },
			{ path: "/bin/sh" },
		])
			expect(() =>
				input({ action: "load-cpu", lab: "demo-load", ...extra }),
			).toThrow();
	});
	test("status and stop require an existing lab; Create and Configure never accept the old load flag", () => {
		for (const action of ["load-status", "stop-load"]) {
			expect(() => input({ action, lab: "" })).toThrow();
			expect(
				survey(input({ action, lab: "demo-load", fleet: "gcp-gpu" })),
			).toEqual({ DEMO_LAB: "demo-load", DEMO_FLEET: "gcp-gpu" });
		}
		for (const action of ["create-gpu", "configure"]) {
			expect(() => input({ action, lab: "demo-load", load: "yes" })).toThrow();
			expect(survey(input({ action, lab: "demo-load" }))).not.toHaveProperty(
				"DEMO_LOAD",
			);
		}
	});
	test("CPU limits and fixed on-demand ARM preset", () => {
		expect(survey(input({ count: "200" }))).toEqual({
			DEMO_COUNT: "200",
			DEMO_TTL: "15m",
			DEMO_COST: "on-demand",
			DEMO_PRESET: "t4g-nano",
		});
		for (const count of ["0", "201", "-1", "1.5", "1;whoami"])
			expect(() => input({ count })).toThrow();
		for (const extra of [
			{ template_id: 99 },
			{ environment: {} },
			{ branch: "main" },
			{ arguments: ["--check"] },
			{ url: "https://evil.invalid" },
		])
			expect(() => input(extra)).toThrow();
	});
	test("cost, delete and discard confirmations; explicit existing labs", () => {
		expect(() => input({ confirmed: false })).toThrow();
		expect(() => input({ action: "destroy", lab: "" })).toThrow();
		expect(() =>
			input({
				action: "move",
				lab: "demo-test",
				discard: true,
				confirmed: false,
			}),
		).toThrow();
		expect(
			survey(input({ action: "move", lab: "demo-test" })).DEMO_DISCARD,
		).toBe("drain");
		expect(
			survey(input({ action: "destroy", lab: "demo-test" })).DEMO_CONFIRM,
		).toBe("delete");
		expect(() => input({ lab: "../escape" })).toThrow();
		expect(() => input({ action: "create-gpu", count: "2" })).toThrow();
	});
});

describe("pinned Semaphore API connector", () => {
	test("action metadata must have the exact current survey names, targets and enum choices", async () => {
		const current = nativeSurvey("create-cpu");
		for (const survey_vars of [
			undefined,
			null,
			[],
			current.slice(1),
			[...current, current[0]],
			current.map((item) =>
				item.name === "DEMO_LAB" ? { ...item, required: true } : item,
			),
			current.map((item) =>
				item.name === "DEMO_LAB"
					? { ...item, default_value: "fallback-lab" }
					: item,
			),
			current.map((item) =>
				item.name === "DEMO_COUNT" ? { ...item, target: "" } : item,
			),
			current.map((item) =>
				item.name === "DEMO_PRESET"
					? { ...item, values: [{ value: "arbitrary-instance" }] }
					: item,
			),
			[
				...current,
				{ name: "DEMO_PROJECT_ID", target: "env", default_value: otherProject },
			],
		]) {
			const { connector, calls } = upstream({
				templates: [{ ...template, survey_vars }],
			});
			await expect(connector.run(input())).rejects.toMatchObject({
				code: "UNAVAILABLE",
			});
			expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
		}
	});
	test("List never fetches fleet-wide output even when its template is project-bound; Destroy still requires a lab grant", async () => {
		const environment = "{}";
		const listed = {
			...task,
			environment,
			message: taskScopeMessage(
				config.token,
				reference.projectId,
				4,
				environment,
				"list",
			),
		};
		const { connector, calls } = upstream({
			templates: [{ ...template, playbook: playbooks.list }],
			"tasks/20": listed,
			"tasks/last?count=30": [listed],
		});
		expect(await connector.recent(reference.projectId)).toEqual([
			{ id: 20, action: "list", status: task.status, created: task.created },
		]);
		expect(await connector.output(reference.projectId, 20)).toBe("");
		expect(calls.some((call) => call.path.endsWith("/output"))).toBe(false);
		const denied = operations(connector, { labGrant: () => null }).api;
		await expect(
			denied.run(
				database,
				actor,
				input({ action: "destroy", lab: "demo-lab" }),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
	});
	test("project groups cannot supply fallbacks or overrides for signed survey fields", async () => {
		for (const changes of [
			{
				env: JSON.stringify({
					...JSON.parse(group.env),
					DEMO_LAB: "other-lab",
				}),
			},
			{ json: JSON.stringify({ DEMO_TTL: "4h" }) },
			{
				secrets: [
					...group.secrets,
					{ name: "DEMO_COST", type: "env", secret: "unknown" },
				],
			},
		]) {
			const { connector, calls } = upstream({
				"environment/9": { ...group, ...changes },
			});
			await expect(connector.run(input())).rejects.toMatchObject({
				code: "UNAVAILABLE",
			});
			expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
		}
	});
	test("real local HTTP transport carries bearer auth but never follows upstream redirects", async () => {
		const credentials: (string | null)[] = [];
		let redirected = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				credentials.push(request.headers.get("Authorization"));
				if (new URL(request.url).pathname === "/unexpected") {
					redirected++;
					return Response.json([]);
				}
				return Response.redirect(new URL("/unexpected", request.url), 302);
			},
		});
		try {
			const connector = new Semaphore(config, ((url, init) => {
				const path = new URL(String(url)).pathname;
				return fetch(new URL(path, server.url), init);
			}) as typeof fetch);
			await expect(connector.recent(reference.projectId)).rejects.toMatchObject(
				{ code: "UNAVAILABLE" },
			);
			expect(credentials[0]).toBe(`Bearer ${config.token}`);
			expect(redirected).toBe(0);
		} finally {
			await server.stop(true);
		}
	});
	test("uses scoped native task endpoint and JSON-string survey, never passes secrets", async () => {
		const { connector, calls } = upstream();
		expect(await connector.run(input())).toEqual({ id: 20 });
		const post = calls.find((call) => call.init?.method === "POST");
		expect(post?.path).toBe("tasks");
		expect(JSON.parse(String(post?.init?.body))).toEqual({
			template_id: 4,
			environment: JSON.stringify(survey(input())),
			message: taskScopeMessage(
				config.token,
				reference.projectId,
				4,
				JSON.stringify(survey(input())),
				"create-cpu",
			),
		});
		expect(post?.init?.redirect).toBe("error");
		expect(
			JSON.stringify(await connector.recent(reference.projectId)),
		).not.toContain(config.token);
	});
	test("wrong variable-group tenant, shadowed target, missing encrypted key and ambiguous copies fail closed", async () => {
		for (const override of [
			{
				...group,
				env: JSON.stringify({
					DEMO_PROJECT_ID: otherProject,
					DEMO_PROJECT: "other",
				}),
			},
			{ ...group, json: JSON.stringify({ DEMO_PROJECT_ID: otherProject }) },
			{ ...group, secrets: [] },
			{
				...group,
				secrets: [...group.secrets, { name: "DEMO_PROJECT_ID", type: "var" }],
			},
		]) {
			const { connector, calls } = upstream({ "environment/9": override });
			await expect(connector.run(input())).rejects.toMatchObject({
				code: "UNAVAILABLE",
			});
			expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
		}
		const { connector } = upstream({
			templates: [template, { ...template, id: 5, name: "Trusted name" }],
		});
		await expect(connector.run(input())).rejects.toMatchObject({
			code: "UNAVAILABLE",
		});
	});
	test("effective groups, app and paths cannot be substituted", async () => {
		for (const altered of [
			{ ...template, environment_ids: [9, 10] },
			{ ...template, app: "bash" },
			{ ...template, playbook: "infra/demo/../../evil.yml" },
			{ ...template, working_directory: "other" },
		]) {
			const { connector, calls } = upstream({ templates: [altered] });
			await expect(connector.run(input())).rejects.toMatchObject({
				code: "UNAVAILABLE",
			});
			expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
		}
	});
	test("GPU stays disabled without explicit server opt-in", async () => {
		const { connector, calls } = upstream();
		await expect(
			connector.run(input({ action: "create-gpu" })),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(calls).toHaveLength(0);
	});
	test("actual task status is projected; project overrides and foreign tasks are omitted", async () => {
		const { connector } = upstream({
			"tasks/last?count=30": [
				task,
				{ ...task, id: 21, project_id: 8 },
				{
					...task,
					id: 22,
					environment: JSON.stringify({ DEMO_PROJECT_ID: otherProject }),
				},
			],
		});
		expect(await connector.recent(reference.projectId)).toEqual([
			{
				id: 20,
				action: "create-cpu",
				status: "running",
				created: task.created,
				nativeUrl: "https://semaphore-ui.invalid/project/7/history?t=20",
			},
		]);
	});
	test("load templates use project metadata without requiring an enrollment secret; GPU load does not provision", async () => {
		for (const action of [
			"load-cpu",
			"load-gpu",
			"load-status",
			"stop-load",
		] as const) {
			const { connector, calls } = upstream({
				templates: [{ ...template, playbook: playbooks[action] }],
				"environment/9": { ...group, secrets: [] },
			});
			const { api } = operations(connector, {
				labGrant: () => ({
					...reference,
					fleet: action === "load-gpu" ? "gcp-gpu" : "aws-cpu",
				}),
			});
			expect(
				await api.run(database, actor, input({ action, lab: "demo-load" })),
			).toEqual({ id: 20 });
			const post = calls.find((call) => call.init?.method === "POST");
			const values = JSON.parse(
				JSON.parse(String(post?.init?.body)).environment,
			);
			expect(values).not.toHaveProperty("DEMO_PRESET");
			expect(values).not.toHaveProperty("DEMO_ENROLLMENT_KEY");
			expect(values).not.toHaveProperty("DEMO_LOAD");
			if (action === "load-cpu" || action === "load-gpu")
				expect(values).not.toHaveProperty("DEMO_FLEET");
		}
	});
	test("load history and output independently recheck the current lab grant", async () => {
		const action: WorkflowAction = "load-status";
		const environment = JSON.stringify({
			DEMO_LAB: "demo-load",
			DEMO_FLEET: "aws-cpu",
		});
		const loadTask = {
			...task,
			environment,
			message: taskScopeMessage(
				config.token,
				reference.projectId,
				4,
				environment,
				action,
			),
		};
		const fixture = () =>
			upstream({
				templates: [{ ...template, playbook: playbooks[action] }],
				"environment/9": { ...group, secrets: [] },
				"tasks/last?count=30": [loadTask],
				"tasks/20": loadTask,
				"tasks/20/output": [
					{ output: "job=private-result enrollment-key=secret" },
					{ output: "RECOUNT_PUBLIC lab=demo-load" },
				],
			});
		const denied = fixture();
		const { api } = operations(denied.connector, {
			labGrant: () => ({
				...reference,
				projectId: otherProject,
				fleet: "aws-cpu",
			}),
		});
		expect(await api.recent(database, actor, reference)).toEqual([]);
		await expect(
			api.output(database, actor, { ...reference, taskId: 20 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(denied.calls.some((call) => call.path.endsWith("/output"))).toBe(
			false,
		);
		const allowed = operations(fixture().connector).api;
		expect(
			await allowed.output(database, actor, { ...reference, taskId: 20 }),
		).toBe("[redacted]");
	});
	test("structured results reject untrusted log text and native logs redact credential lines", async () => {
		for (const line of [
			config.token,
			"DEMO_ENROLLMENT_KEY=secret",
			"<script>alert(1)</script>",
			'{"secret":"value"}',
			"RECOUNT_PUBLIC ttl=15m token=secret",
		])
			expect(
				publicTaskOutput([line], {
					action: "create-cpu",
					projectId: reference.projectId,
					survey: {},
				}),
			).toBe("");
		const { connector } = upstream();
		expect(await connector.output(reference.projectId, 20)).toBe("[redacted]");
	});
	test("cannot fetch output from another template or project", async () => {
		const { connector, calls } = upstream({
			"tasks/20": { ...task, template_id: 999 },
		});
		await expect(
			connector.output(reference.projectId, 20),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(calls.some((call) => call.path.endsWith("/output"))).toBe(false);
	});
	test("connector publishes Create metadata only from an authorized task with a matching signed survey", async () => {
		const environment = JSON.stringify(survey(input()));
		const message = taskScopeMessage(
			config.token,
			reference.projectId,
			4,
			environment,
			"create-cpu",
		);
		const payload = { lab_id: "demo-0123456789abcdef", ttl: "15m" };
		const marker = `"msg": "RECOUNT_PUBLIC_CREATE ${Buffer.from(JSON.stringify(payload)).toString("base64")}"`;
		const { connector, calls } = upstream({
			"tasks/20": { ...task, environment, message },
			"tasks/20/output": [
				{
					output: `TASK [Create collectors] ****\n    ${marker}\nAWS_SECRET_ACCESS_KEY=example`,
				},
				...Array.from({ length: 516 }, () => ({
					output: "private diagnostic",
				})),
			],
		});
		const output = await connector.output(reference.projectId, 20);
		expect(output).toStartWith("TASK [Create collectors] ****\n[redacted]");
		expect(output).not.toContain("AWS_SECRET_ACCESS_KEY");
		expect(output).not.toContain("RECOUNT_PUBLIC_CREATE");
		expect(output).toEndWith(JSON.stringify(payload, null, 2));
		expect(calls.some((call) => call.path.endsWith("/output"))).toBe(true);
		const mismatched = upstream({
			"tasks/20": { ...task, id: 21, environment, message },
		});
		await expect(
			mismatched.connector.output(reference.projectId, 20),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mismatched.calls.some((call) => call.path.endsWith("/output"))).toBe(
			false,
		);
	});
	test("historical rebinding, unsigned tasks and modified survey data cannot cross project reads", async () => {
		for (const altered of [
			{ ...task, message: undefined },
			{ ...task, environment: '{"DEMO_LAB":"demo-other"}' },
			{
				...task,
				message: taskScopeMessage(
					config.token,
					otherProject,
					4,
					"{}",
					"create-cpu",
				),
			},
			{
				...task,
				message: taskScopeMessage(
					config.token,
					reference.projectId,
					4,
					"{}",
					"destroy",
				),
			},
		]) {
			const { connector, calls } = upstream({
				"tasks/20": altered,
				"tasks/last?count=30": [altered],
			});
			expect(await connector.recent(reference.projectId)).toEqual([]);
			await expect(
				connector.output(reference.projectId, 20),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(calls.some((call) => call.path.endsWith("/output"))).toBe(false);
		}
	});
	test("upstream failures and malformed bodies expose no response body or token", async () => {
		for (const response of [
			new Response("secret diagnostic", { status: 403 }),
			new Response("secret diagnostic", { status: 500 }),
			new Response("not-json"),
			new Response("x".repeat(2_000_001)),
			new Error(`network ${config.token}`),
		]) {
			const { connector } = upstream({ templates: response });
			await expect(connector.recent(reference.projectId)).rejects.toMatchObject(
				{ code: "UNAVAILABLE" },
			);
		}
		const { connector } = upstream({
			tasks: new Response("secret diagnostic", { status: 500 }),
		});
		await expect(connector.run(input())).rejects.toThrow(
			"Workflow submission outcome is unknown",
		);
	});
});
