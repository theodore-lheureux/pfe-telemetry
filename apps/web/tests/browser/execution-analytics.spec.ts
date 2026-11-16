import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { Page } from "@playwright/test";
import { defaultStringifySearch } from "@tanstack/react-router";
import { addTiles, saveDashboard } from "../../src/analytics/dashboards.server";
import {
	DEFAULT_DRAFT,
	encodeDraft,
	newSeries,
} from "../../src/analytics/insight/draft";
import { saveInsight } from "../../src/analytics/saved-insights.server";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { executionParticipant } from "../execution-participant";
import { createPointFixture, insertPoints } from "../telemetry/fixture";
import { test as base, data, expect } from "./fixtures";

const test = base.extend<{
	telemetry: Awaited<ReturnType<typeof createPointFixture>>;
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture arguments.
	telemetry: async ({}, use) => {
		const fixture = await createPointFixture({ participants: true });
		try {
			await use(fixture);
		} finally {
			await fixture.close();
		}
	},
	workspaceEnvironment: async ({ telemetry }, use) => {
		// The application keeps its fixed reader configuration; only this proxy maps it
		// to the test's disposable database and SELECT-only account.
		const config = telemetry.readerConfig;
		const server = createServer((incoming, outgoing) => {
			const url = new URL(incoming.url ?? "/", config.url);
			url.searchParams.set("database", config.database);
			const upstream = request(
				url,
				{
					method: incoming.method,
					headers: {
						...incoming.headers,
						host: url.host,
						authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
					},
				},
				(response) => {
					outgoing.writeHead(response.statusCode ?? 500, response.headers);
					response.pipe(outgoing);
				},
			);
			upstream.on("error", () => {
				outgoing.writeHead(502);
				outgoing.end();
			});
			incoming.pipe(upstream);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Expected test port");
		try {
			await use({
				RECOUNT_CLICKHOUSE_URL: `http://127.0.0.1:${address.port}`,
				RECOUNT_CLICKHOUSE_READER_PASSWORD: "fixture",
			});
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
});

async function selectExecution(page: Page, button: string) {
	await expect(
		page.getByRole("button", { name: button, exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: button, exact: true }).click();
	await page.getByRole("option", { name: "Execution", exact: true }).click();
	await page.getByRole("option", { name: "run:shared", exact: true }).click();
}

test("execution filters and breakdowns survive saved insights, dashboard overrides and Activity Explorer", async ({
	page,
	workspace,
	telemetry,
}, testInfo) => {
	const actor = await workspace.signIn(
		page,
		`execution-analytics-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Execution analytics",
				slug: `execution-analytics-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await workspace.operations(actor.headers, (actor) =>
			createProject(workspace.database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Processes",
			}),
		),
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	const time = BigInt(Date.now() - 30_000) * 1_000_000n;
	const node = randomUUID();
	for (const [resource, value] of [
		["process-a", 2],
		["process-b", 5],
	] as const)
		await telemetry.client.command({
			query: insertPoints({
				resource_id: "{resource:String}",
				resource_kind: "toUInt8(4)",
				metric_name: "'process.memory.usage'",
				metric_kind: "toUInt8(1)",
			}),
			query_params: {
				project: project.id,
				source: node,
				host: node,
				resource,
				time: time.toString(),
				integer: String(value),
				sample: randomUUID(),
				stream: resource,
				epoch: "epoch",
			},
		});
	await telemetry.client.insert({
		table: "execution_participants",
		format: "JSONEachRow",
		values: [
			{
				...executionParticipant(project.id, "run:shared", {
					nodeId: node,
					firstSeen: time,
				}),
				fact_id: randomUUID(),
				kind: 2,
				process_resource_id: "process-a",
				process_namespace_id: "pidns:1",
				process_pid: 42,
				process_start_time_ticks: "100",
				execution_name: null,
				workload_version: null,
				parameters: [],
			},
		],
	});
	const draft = {
		...DEFAULT_DRAFT,
		series: [
			{
				...newSeries("A"),
				metric: "process.memory.usage",
				calculation: "avg" as const,
				combine: "sum" as const,
			},
		],
		display: { ...DEFAULT_DRAFT.display, type: "table" as const },
	};
	const path = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}`;
	await page.goto(
		`${path}/explore${defaultStringifySearch({ q: encodeDraft(draft) })}`,
	);
	await expect(
		page.getByRole("table", { name: "Results", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: /^Breakdown:/ }).click();
	await page.getByRole("option", { name: "Execution", exact: true }).click();
	const results = page.getByRole("table", { name: "Results", exact: true });
	await expect(results.getByRole("row")).toHaveCount(3);
	await expect(results).toContainText("run:shared");
	await selectExecution(page, "Add filter");
	await expect(results.getByRole("row")).toHaveCount(2);
	await expect(
		results.getByRole("cell", { name: "2 B", exact: true }),
	).toBeVisible();
	await page.reload();
	await expect(results.getByRole("row")).toHaveCount(2);
	await expect(
		page.getByText("Execution = run:shared", { exact: true }),
	).toBeVisible();

	const saved = data(
		await workspace.operations(actor.headers, (actor) =>
			saveInsight(workspace.database.db, actor, {
				...reference,
				insightId: randomUUID(),
				name: "Execution load",
				draft: encodeDraft({ ...draft, groupBy: "execution" }),
			}),
		),
	);
	const dashboard = data(
		await workspace.operations(actor.headers, (actor) =>
			saveDashboard(workspace.database.db, actor, {
				...reference,
				dashboardId: randomUUID(),
				name: "Execution comparison",
			}),
		),
	);
	data(
		await workspace.operations(actor.headers, (actor) =>
			addTiles(workspace.database.db, actor, {
				...reference,
				dashboardId: dashboard.id,
				insightIds: [saved.id],
			}),
		),
	);
	await page.goto(`${path}/dashboards/${dashboard.id}`);
	const tile = page.getByRole("article", {
		name: "Execution load",
		exact: true,
	});
	await expect(tile.getByRole("row")).toHaveCount(3);
	await selectExecution(page, "Filter");
	await expect(tile.getByRole("row")).toHaveCount(2);
	await expect(tile).toContainText("run:shared");
	await page.screenshot({
		path: testInfo.outputPath("execution-dashboard.png"),
		fullPage: true,
	});

	await page.goto(`${path}/activity`);
	const points = page.getByRole("table", { name: "Explorer", exact: true });
	await expect(points.getByRole("row")).toHaveCount(3);
	await selectExecution(page, "Attribute filters");
	await expect(points.getByRole("row")).toHaveCount(2);
	await expect(
		page.getByText("Execution = run:shared", { exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("execution-explorer.png"),
		fullPage: true,
	});
});
