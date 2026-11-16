import { once } from "node:events";
import { createServer } from "node:http";
import { m } from "@recount/i18n/messages";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import {
	test as base,
	data,
	dismissPasskeySetup,
	expect,
	openWorkspaceMenu,
} from "./fixtures";

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

test("an account switch leaves no previous execution data in rendered, cached or restored pages", async ({
	page,
	workspace,
	executionRows,
}) => {
	const replacementEmail = "switch-member@example.invalid";
	const replacement = await workspace.signIn(page, replacementEmail);
	const owner = await workspace.signIn(page, "switch-owner@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizations.createOrganization(workspace.auth, owner.headers, {
				name: "Account switch",
				slug: "account-switch",
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
	// The next account belongs to the organization but has no project role.
	await workspace.auth.api.addMember({
		body: {
			organizationId: organization.id,
			userId: replacement.userId,
			role: "member",
		},
	});
	const name = "Confidential workload";
	const executionKey = "run:confidential";
	executionRows.push({
		project: project.id,
		executionKey,
		name,
		workloadVersion: null,
		parameters: [],
		nodeCount: 1,
		participantCount: 1,
		environmentVariables: ["RECOUNT_EXECUTION"],
		firstSeenNs: "1793700000000000000",
		lastSeenNs: "1793700001000000000",
	});
	const list = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`;
	const detail = `${list}/${encodeURIComponent(executionKey)}`;
	await page.goto(list);
	await expect(
		page.getByRole("button", {
			name: "Switch project, organization or account",
			exact: true,
		}),
	).toBeEnabled();
	await page.getByRole("link", { name, exact: true }).click();
	await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
	await expect(page).toHaveURL(detail);
	// Keep both execution pages in history; sign-in and sign-out replace their own entries.
	await page
		.getByRole("navigation", { name: "Project navigation" })
		.getByRole("link", { name: "Overview", exact: true })
		.click();
	await expect(page).not.toHaveURL(detail);

	await openWorkspaceMenu(page);
	await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true }),
	).toBeVisible();
	await workspace.enableCodeDelivery(page);
	await page
		.getByLabel("Email address", { exact: true })
		.fill(replacementEmail);
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await workspace.submitReceivedCode(page, replacementEmail);
	await dismissPasskeySetup(page);
	await expect(page).not.toHaveURL(/\/login/);

	const absent = async () => {
		await expect(
			page.getByRole("heading", { name: "Page not found", exact: true }),
		).toBeVisible();
		await expect(page.getByText(name)).toHaveCount(0);
		const html = await page.content();
		expect(html).not.toContain(name);
		expect(html).not.toContain(executionKey);
	};
	// Back navigation must reload with the new identity rather than restore the old page.
	for (const url of [detail, list]) {
		for (let step = 0; step < 4 && page.url() !== url; step++)
			await page.goBack({ waitUntil: "commit" });
		expect(page.url()).toBe(url);
		await absent();
	}
	const response = await page.goto(detail);
	expect(response?.status()).toBe(404);
	await absent();
});
