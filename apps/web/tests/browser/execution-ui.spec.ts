import { once } from "node:events";
import { createServer } from "node:http";
import { m } from "@recount/i18n/messages";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
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
	/** Whether the process membership reported an end. */
	ended?: boolean;
}
const test = base.extend<{ executionRows: Row[] }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture arguments.
	executionRows: async ({}, use) => {
		await use([]);
	},
	workspaceEnvironment: async ({ executionRows }, use) => {
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
				const rows = executionRows.filter(
					(row) =>
						row.project === params.get("param_project") &&
						(!params.get("param_key") ||
							row.executionKey === params.get("param_key")) &&
						row.executionKey > (params.get("param_after") ?? ""),
				);
				response.writeHead(200, { "Content-Type": "application/json" });
				let output: object[] = rows;
				if (query.includes("AS participantId"))
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
							endedNs: row.ended ? "1793700001500000000" : null,
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
				name: m.execution_timeline_title({}, { locale }),
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: m.execution_timeline_live({}, { locale }),
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: m.execution_timeline_clock_unknown({}, { locale }),
			}),
		).toBeVisible();
		// A live execution refreshes on demand; the page does not stream.
		await expect(
			page.getByRole("button", {
				name: m.overview_refresh({}, { locale }),
				exact: true,
			}),
		).toBeVisible();
		// Every value is unavailable here, and the page says so instead of showing zeros.
		await expect(
			page.getByRole("heading", {
				name: m.execution_timeline_no_measurements({}, { locale }),
			}),
		).toBeVisible();
		const machine = page.getByRole("button", {
			name: m.execution_timeline_select_machine(
				{ node: "compute-a" },
				{ locale },
			),
		});
		await expect(machine).toHaveAttribute("aria-pressed", "false");
		const lifecycle = page.getByRole("button", {
			name: new RegExp(
				`^${m.execution_lifecycle({}, { locale })}, .* · compute-a$`,
			),
		});
		await lifecycle.focus();
		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toContainText(
			m.execution_interval_end({}, { locale }),
		);
		await expect(tooltip).not.toContainText(
			m.execution_timeline_still_observed({}, { locale }),
		);
		// Keyboard focus moves to the process membership, which is still open.
		await page.keyboard.press("Tab");
		const process = page.getByRole("button", {
			name: /^PID 42, .* · compute-a$/,
		});
		await expect(process).toBeFocused();
		const openSuffix = m
			.execution_timeline_open_interval(
				{ name: "", from: "", to: "" },
				{ locale },
			)
			.split(", ")
			.at(-1);
		await expect(process).toHaveAccessibleName(
			new RegExp(`, ${openSuffix} · compute-a$`),
		);
		await expect(lifecycle).not.toHaveAccessibleName(
			new RegExp(`, ${openSuffix} · compute-a$`),
		);
		const processTooltip = page
			.getByRole("tooltip")
			.filter({ hasText: "process-resource-a" });
		await expect(processTooltip).toBeVisible();
		await expect(processTooltip).toContainText(
			m.execution_timeline_still_observed({}, { locale }),
		);
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/[?&]node=compute-a/);
		await expect(page).toHaveURL(/[?&]at=2026-11-03T10%3A00%3A00.000Z/);
		await expect(machine).toHaveAttribute("aria-pressed", "true");
		await expect(
			page.getByText(
				m.execution_timeline_scope_node({ node: "compute-a" }, { locale }),
			),
		).toBeVisible();
		await page.reload();
		await expect(machine).toHaveAttribute("aria-pressed", "true");
		await page
			.getByRole("button", {
				name: m.execution_timeline_all_machines({}, { locale }),
			})
			.click();
		await expect(page).not.toHaveURL(/[?&]node=/);
		await expect(page).toHaveURL(/[?&]at=/);
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
		executionRows.push({
			...executionRows[0],
			executionKey: "run:ended",
			name: "Ended job",
			ended: true,
		});
		await page.goto(`${url}/${encodeURIComponent("run:ended")}`);
		await expect(
			page.getByRole("button", {
				name: m.execution_timeline_ended({}, { locale }),
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: m.execution_timeline_live({}, { locale }),
				exact: true,
			}),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", {
				name: m.overview_refresh({}, { locale }),
				exact: true,
			}),
		).toHaveCount(0);
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
