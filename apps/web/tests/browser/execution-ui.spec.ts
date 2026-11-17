import { once } from "node:events";
import { createServer } from "node:http";
import { m } from "@recount/i18n/messages";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { createTestNode } from "../collector-node";
import { test as base, data, expect } from "./fixtures";

const liveSecret = "execution-live-fixture-secret-only";

interface Row {
	project: string;
	executionKey: string;
	name: string;
	workloadVersion: string | null;
	parameters: [string, string][];
	nodeCount: number;
	participantCount: number;
	environmentVariables: string[];
	firstSeenNs: string;
	lastSeenNs: string;
	running?: boolean;
	nodeIds?: string[];
	ownerUids?: number[];
}

/** A ClickHouse array query parameter, such as `['a','b']` or `[1000]`. */
function arrayParam(params: URLSearchParams, name: string): unknown[] {
	return JSON.parse((params.get(`param_${name}`) ?? "[]").replaceAll("'", '"'));
}

/** The list query's filters, applied as the SQL applies them. */
function matchesFilters(row: Row, params: URLSearchParams) {
	const q = (params.get("param_q") ?? "").toLowerCase();
	const application = arrayParam(params, "application");
	const machine = arrayParam(params, "machine");
	const owner = arrayParam(params, "owner");
	const state = params.get("param_state") ?? "";
	return [
		!q ||
			row.name.toLowerCase().includes(q) ||
			row.executionKey.toLowerCase().includes(q),
		!application.length || application.includes(row.name),
		!state || (row.running ?? false) === (state === "running"),
		!machine.length || (row.nodeIds ?? []).some((id) => machine.includes(id)),
		!owner.length || (row.ownerUids ?? []).some((uid) => owner.includes(uid)),
		BigInt(row.lastSeenNs) >= BigInt(params.get("param_from") ?? "0"),
		BigInt(row.firstSeenNs) <
			BigInt(params.get("param_to") ?? "18446744073709551615"),
	].every(Boolean);
}

interface ExecutionStub {
	rows: Row[];
	/** Makes list queries fail as an unavailable ClickHouse would. */
	failList: boolean;
	/** Query parameters of each list query, in order. */
	listParams: URLSearchParams[];
}
const test = base.extend<{
	executionRows: Row[];
	executionStub: ExecutionStub;
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture arguments.
	executionStub: async ({}, use) => {
		await use({ rows: [], failList: false, listParams: [] });
	},
	executionRows: async ({ executionStub }, use) => {
		await use(executionStub.rows);
	},
	workspaceEnvironment: async ({ executionStub }, use) => {
		const executionRows = executionStub.rows;
		const server = createServer((request, response) => {
			if (request.url?.startsWith("/stream?")) {
				expect(request.headers.authorization).toBe(`Bearer ${liveSecret}`);
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.end("event: heartbeat\ndata: {}\n\n");
				return;
			}
			let query = "";
			request.on("data", (chunk) => {
				query += chunk.toString();
			});
			request.on("end", () => {
				const params = new URL(request.url ?? "/", "http://fixture.invalid")
					.searchParams;
				const project = executionRows.filter(
					(row) => row.project === params.get("param_project"),
				);
				const list = query.includes("LIMIT 51");
				if (list) executionStub.listParams.push(params);
				if (list && executionStub.failList) {
					response.writeHead(500, { "Content-Type": "text/plain" });
					response.end("Code: 210. DB::NetException: fixture outage");
					return;
				}
				const rows = project
					.filter(
						(row) =>
							(!params.get("param_key") ||
								row.executionKey === params.get("param_key")) &&
							row.executionKey > (params.get("param_after") ?? "") &&
							(!list || matchesFilters(row, params)),
					)
					.map((row) => ({
						running: false,
						nodeIds: [],
						ownerUids: [],
						...row,
					}));
				response.writeHead(200, { "Content-Type": "application/json" });
				let output: object[] = rows;
				if (query.includes("AS applications"))
					output = [
						{
							applications: [...new Set(project.map((row) => row.name))].sort(),
							machines: [
								...new Set(project.flatMap((row) => row.nodeIds ?? [])),
							].sort(),
							owners: [
								...new Set(project.flatMap((row) => row.ownerUids ?? [])),
							].sort((a, b) => a - b),
						},
					];
				else if (query.includes("AS participantId"))
					output = rows.flatMap((row) => [
						{
							nodeId: "compute-a",
							participantId: "participant-a",
							factId: "participant-a",
							kind: 1,
							processResourceId: null,
							namespaceId: null,
							pid: null,
							startTimeTicks: null,
							ownerUid: 1000,
							environmentVariable: "RECOUNT_EXECUTION",
							firstSeenNs: row.firstSeenNs,
							lastSeenNs: row.lastSeenNs,
							endedNs: "1793700002000000000",
						},
						{
							nodeId: "compute-a",
							participantId: "participant-a",
							factId: "membership-a",
							kind: 2,
							processResourceId: "process-resource-a",
							namespaceId: "pidns:1",
							pid: 42,
							startTimeTicks: "100",
							ownerUid: 0,
							environmentVariable: "RECOUNT_EXECUTION",
							firstSeenNs: row.firstSeenNs,
							lastSeenNs: row.lastSeenNs,
							endedNs: null,
						},
					]);
				response.end(
					query.includes("execution_participants")
						? output.map((row) => `${JSON.stringify(row)}\n`).join("")
						: "",
				);
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Expected fixture port");
		try {
			await use({
				RECOUNT_CLICKHOUSE_URL: `http://127.0.0.1:${address.port}`,
				RECOUNT_CLICKHOUSE_READER_PASSWORD: "fixture",
				RECOUNT_LIVE_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
				RECOUNT_LIVE_GATEWAY_SECRET: liveSecret,
			});
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
});

for (const locale of ["en", "fr"] as const) {
	test(`execution keys and lifecycle metadata are read-only (${locale})`, async ({
		page,
		workspace,
		executionRows,
	}, testInfo) => {
		const owner = await workspace.signIn(
			page,
			`execution-${locale}@example.invalid`,
		);
		const organization = data(
			await workspace.operations(owner.headers, () =>
				organizations.createOrganization(workspace.auth, owner.headers, {
					name: "Executions",
					slug: `executions-${locale}`,
				}),
			),
		);
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projects.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Private",
				}),
			),
		);
		const url = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`;
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.goto(url);
		await expect(
			page.getByText(m.execution_claims_hint({}, { locale })),
		).toBeVisible();
		executionRows.push({
			project: project.id,
			executionKey: "run:Node-A/one",
			name: "Distributed job",
			workloadVersion: "build-a",
			parameters: [["label", "<node>"]],
			nodeCount: 2,
			participantCount: 2,
			environmentVariables: ["RECOUNT_EXECUTION"],
			firstSeenNs: "1793700000000000000",
			lastSeenNs: "1793700001000000000",
		});
		await page.reload();
		await page
			.getByRole("link", { name: "Distributed job", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Distributed job", exact: true }),
		).toBeVisible();
		await expect(page.getByText("run:Node-A/one")).toBeVisible();
		await expect(page.getByText("<node>", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("heading", {
				name: m.execution_memberships({}, { locale }),
			}),
		).toBeVisible();
		await expect(page.getByText("compute-a", { exact: true })).toBeVisible();
		await expect(
			page.getByText("process-resource-a", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText(m.execution_interval_end({}, { locale }), { exact: true }),
		).toHaveCount(2);
		await expect(
			page.locator('time[datetime="2026-11-03T10:00:02.000Z"]'),
		).toBeVisible();
		await expect(
			page.getByText(m.execution_end_unknown({}, { locale }), { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: m.record_execution({}, { locale }),
				exact: true,
			}),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", {
				name: m.save_name({}, { locale }),
				exact: true,
			}),
		).toHaveCount(0);
		await page.screenshot({
			path: testInfo.outputPath(`execution-key-${locale}.png`),
			fullPage: true,
		});
		await workspace.signIn(
			page,
			`execution-outsider-${locale}@example.invalid`,
		);
		const response = await page.goto(
			`${url}/${encodeURIComponent("run:Node-A/one")}`,
		);
		expect(response?.status()).toBe(404);
		await expect(page.getByText("run:Node-A/one")).toHaveCount(0);
	});
}

test("two project readers and an organization operator use isolated execution pages, RPCs and live channels", async ({
	page,
	workspace,
	executionRows,
}) => {
	const operatorEmail = "operator@example.invalid";
	const operator = await workspace.signIn(page, operatorEmail);
	const organization = data(
		await workspace.operations(operator.headers, () =>
			organizations.createOrganization(workspace.auth, operator.headers, {
				name: "Execution access",
				slug: "execution-access",
			}),
		),
	);
	const allocations = [];
	for (const name of ["Alpha", "Beta"]) {
		const project = data(
			await workspace.operations(operator.headers, (actor) =>
				projects.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name,
				}),
			),
		);
		const email = `${name.toLowerCase()}@example.invalid`;
		const reader = await workspace.signIn(page, email);
		const membership = await workspace.auth.api.addMember({
			body: {
				organizationId: organization.id,
				userId: reader.userId,
				role: "member",
			},
		});
		data(
			await workspace.operations(operator.headers, (actor) =>
				projects.setProjectMember(workspace.database.db, actor, {
					organizationId: organization.id,
					projectId: project.id,
					memberId: membership.id,
					role: "viewer",
				}),
			),
		);
		executionRows.push({
			project: project.id,
			executionKey: "run:shared",
			name: `${name} private workload`,
			workloadVersion: null,
			parameters: [],
			nodeCount: 1,
			participantCount: 1,
			environmentVariables: ["RECOUNT_EXECUTION"],
			firstSeenNs: "1793700000000000000",
			lastSeenNs: "1793700001000000000",
		});
		allocations.push({
			email,
			projectId: project.id,
			name: `${name} private workload`,
			url: `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`,
			rpc: "",
		});
	}
	await workspace.signIn(page, operatorEmail);
	for (const allocation of allocations) {
		await page.goto(allocation.url);
		await expect(
			page.getByRole("button", {
				name: "Switch project, organization or account",
				exact: true,
			}),
		).toBeEnabled();
		const path = await workspace.serverFunctionPath(
			page,
			"../executions/execution.functions",
			"getExecution",
		);
		const rpc = page.waitForRequest((request) =>
			request.url().startsWith(new URL(path, workspace.origin).href),
		);
		await page
			.getByRole("link", { name: allocation.name, exact: true })
			.dispatchEvent("click", { button: 0 });
		allocation.rpc = (await rpc).url();
		await expect(
			page.getByRole("heading", { name: allocation.name, exact: true }),
		).toBeVisible();
	}
	for (const email of [operatorEmail, ...allocations.map((a) => a.email)]) {
		await workspace.signIn(page, email);
		for (const allocation of allocations) {
			const allowed = email === operatorEmail || email === allocation.email;
			const response = await page.goto(`${allocation.url}/run%3Ashared`);
			expect(response?.status()).toBe(allowed ? 200 : 404);
			if (allowed) {
				await expect(
					page.getByRole("heading", { name: allocation.name, exact: true }),
				).toBeVisible();
			} else {
				await expect(
					page.getByText(allocation.name, { exact: true }),
				).toHaveCount(0);
			}
			const direct = await page.request.get(allocation.rpc, {
				headers: {
					"x-tsr-serverFn": "true",
					accept: "application/json",
					origin: workspace.origin,
					"sec-fetch-site": "same-origin",
				},
			});
			const body = await direct.text();
			if (allowed) {
				expect(body).toContain(allocation.name);
			} else {
				expect(body).toContain("NOT_FOUND");
				expect(body).not.toContain(allocation.name);
			}
			const live = await page.request.get(
				`${workspace.origin}/api/activity/live?${new URLSearchParams({
					organizationId: organization.id,
					projectId: allocation.projectId,
				})}`,
			);
			expect(live.headers()["content-type"]).toContain("text/event-stream");
			const events = await live.text();
			if (allowed) {
				expect(events).toContain("event: heartbeat");
				expect(events).not.toContain("event: failure");
			} else {
				expect(events).toContain('"code":"NOT_FOUND"');
				expect(events).not.toContain("event: heartbeat");
			}
		}
	}
});

const HOUR_NS = 3_600_000_000_000n;
const T0 = 1793700000000000000n;
function listedRow(
	project: string,
	executionKey: string,
	name: string,
	{ hours = 0n, ...options }: Partial<Row> & { hours?: bigint } = {},
): Row {
	const first = T0 + hours * HOUR_NS;
	return {
		project,
		executionKey,
		name,
		workloadVersion: "build-a",
		parameters: [],
		nodeCount: options.nodeIds?.length ?? 1,
		participantCount: 1,
		environmentVariables: ["RECOUNT_EXECUTION"],
		firstSeenNs: first.toString(),
		lastSeenNs: (first + HOUR_NS).toString(),
		...options,
	};
}

type Locale = "en" | "fr";
const say =
	(locale: Locale) =>
	(message: (inputs: object, options: { locale: Locale }) => string) =>
		message({}, { locale });

/** A signed-in owner's project with three listed executions; returns its list URL. */
const filterTest = test.extend<{
	filteredProject: (locale: Locale) => Promise<string>;
}>({
	filteredProject: async ({ page, workspace, executionStub: stub }, use) => {
		await use(async (locale) => {
			const owner = await workspace.signIn(
				page,
				`execution-filters-${locale}@example.invalid`,
			);
			const organization = data(
				await workspace.operations(owner.headers, () =>
					organizations.createOrganization(workspace.auth, owner.headers, {
						name: "Execution filters",
						slug: `execution-filters-${locale}`,
					}),
				),
			);
			const project = data(
				await workspace.operations(owner.headers, (actor) =>
					projects.createProject(workspace.database.db, actor, {
						requestId: crypto.randomUUID(),
						organizationId: organization.id,
						name: "Filtered",
					}),
				),
			);
			const { nodeId } = await createTestNode(
				workspace.database.db,
				{ organizationId: organization.id, projectId: project.id },
				{ hostname: "compute-a" },
			);
			stub.rows.push(
				listedRow(project.id, "run:alpha", "Alpha training", {
					running: true,
					nodeIds: [nodeId],
					ownerUids: [1000],
				}),
				listedRow(project.id, "run:beta", "Beta inference", {
					nodeIds: [nodeId],
					ownerUids: [2000],
					hours: 2n,
				}),
				listedRow(project.id, "slurm:42", "Gamma sweep", {
					nodeIds: ["c0ffee00-0000-4000-8000-000000000000"],
					hours: 4n,
				}),
			);
			await page
				.context()
				.addCookies([
					{ name: "recount_locale", value: locale, url: workspace.origin },
				]);
			return `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`;
		});
	},
});

filterTest(
	"execution filters keep URL state through details, reloads, search, empty results and failures",
	async ({ page, executionStub, filteredProject }) => {
		const t = say("en");
		const url = await filteredProject("en");
		await page.goto(url);
		const table = page.getByRole("table", { name: t(m.executions) });
		const rows = table.locator("tbody tr");
		await expect(rows).toHaveCount(3);
		await expect(table.getByText("compute-a")).toHaveCount(2);
		await expect(
			table.getByText("c0ffee00-0000-4000-8000-000000000000"),
		).toBeVisible();
		await expect(
			table.getByText(t(m.executions_state_running), { exact: true }),
		).toBeVisible();

		await page
			.getByRole("button", { name: t(m.executions_filter_application) })
			.click();
		await page.getByRole("option", { name: "Beta inference" }).click();
		await page.keyboard.press("Escape");
		await expect(page).toHaveURL(/application=/);
		await expect(rows).toHaveCount(1);
		await page
			.getByRole("combobox", { name: t(m.executions_filter_state) })
			.click();
		await page
			.getByRole("option", { name: t(m.executions_state_completed) })
			.click();
		await expect(page).toHaveURL(/state=completed/);
		await expect
			.poll(() => {
				const listed = executionStub.listParams.at(-1);
				return [listed?.get("param_application"), listed?.get("param_state")];
			})
			.toEqual(["['Beta inference']", "completed"]);
		const filtered = page.url();

		await table.getByRole("link", { name: "Beta inference" }).click();
		await expect(
			page.getByRole("heading", { name: "Beta inference", exact: true }),
		).toBeVisible();
		await page.goBack();
		await expect(page).toHaveURL(filtered);
		await expect(rows).toHaveCount(1);
		await expect(
			page.getByRole("combobox", { name: t(m.executions_filter_state) }),
		).toHaveText(t(m.executions_state_completed));
		await page.reload();
		await expect(rows).toHaveCount(1);
		await expect(table.getByText("Beta inference")).toBeVisible();

		await page.goto(
			`${url}?from=${encodeURIComponent("2026-11-03T13:30:00.000Z")}`,
		);
		await expect(rows).toHaveCount(1);
		await expect(table.getByText("Gamma sweep")).toBeVisible();
		await page
			.getByRole("button", { name: new RegExp(t(m.insight_range)) })
			.click();
		await page
			.getByRole("option", { name: t(m.executions_filter_any_time) })
			.click();
		await expect(page).toHaveURL(url);
		await expect(rows).toHaveCount(3);

		const searchbox = page.getByRole("searchbox", {
			name: t(m.executions_search),
		});
		const clearFilters = page.getByRole("button", {
			name: t(m.executions_clear_filters),
		});
		// Clearing before the typing pause elapses must not let the pending search apply.
		await page
			.getByRole("button", { name: t(m.executions_filter_application) })
			.click();
		await page.getByRole("option", { name: "Alpha training" }).click();
		await page.keyboard.press("Escape");
		await expect(rows).toHaveCount(1);
		await searchbox.fill("pending");
		await clearFilters.click();
		await expect(page).toHaveURL(url);
		await expect(searchbox).toHaveValue("");
		await page.waitForTimeout(600);
		await expect(page).toHaveURL(url);
		await expect(rows).toHaveCount(3);

		await searchbox.fill("no such run");
		await expect(
			page.getByRole("heading", { name: t(m.executions_filtered_empty_title) }),
		).toBeVisible();
		await expect(page).toHaveURL(/q=/);
		await clearFilters.last().click();
		await expect(page).toHaveURL(url);
		await expect(rows).toHaveCount(3);
		await expect(searchbox).toHaveValue("");

		executionStub.failList = true;
		await page.reload();
		await expect(
			page.getByRole("heading", { name: t(m.executions_error_title) }),
		).toBeVisible();
		await expect(page.getByRole("alert")).toHaveText(
			t(m.error_telemetry_unavailable),
		);
		await expect(searchbox).toBeVisible();
		executionStub.failList = false;
		await page.getByRole("button", { name: t(m.try_again) }).click();
		await expect(rows).toHaveCount(3);
	},
);

filterTest(
	"execution filters, empty results and failures are translated (fr)",
	async ({ page, executionStub, filteredProject }) => {
		const t = say("fr");
		const url = await filteredProject("fr");
		await page.goto(`${url}?state=completed`);
		await expect(
			page.getByRole("heading", { name: t(m.executions), exact: true }),
		).toBeVisible();
		const rows = page
			.getByRole("table", { name: t(m.executions) })
			.locator("tbody tr");
		await expect(rows).toHaveCount(2);
		await expect(
			page.getByRole("combobox", { name: t(m.executions_filter_state) }),
		).toHaveText(t(m.executions_state_completed));
		await page.goto(`${url}?q=aucune`);
		await expect(
			page.getByRole("heading", { name: t(m.executions_filtered_empty_title) }),
		).toBeVisible();
		executionStub.failList = true;
		await page.reload();
		await expect(
			page.getByRole("heading", { name: t(m.executions_error_title) }),
		).toBeVisible();
		await expect(page.getByRole("alert")).toHaveText(
			t(m.error_telemetry_unavailable),
		);
	},
);
