import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { Page } from "@playwright/test";
import { m } from "@recount/i18n/messages";
import { defaultStringifySearch } from "@tanstack/react-router";
import { addTiles, saveDashboard } from "../../src/analytics/dashboards.server";
import {
	DEFAULT_DRAFT,
	encodeDraft,
	newSeries,
} from "../../src/analytics/insight/draft";
import { formatValue } from "../../src/analytics/insight/labels";
import { saveInsight } from "../../src/analytics/saved-insights.server";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { createTestNode } from "../collector-node";
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

for (const locale of ["en", "fr"] as const)
	test(`execution page shows member process measurements by machine and instant (${locale})`, async ({
		page,
		workspace,
		telemetry,
	}, testInfo) => {
		const actor = await workspace.signIn(
			page,
			`execution-measurements-${locale}@example.invalid`,
		);
		const organization = data(
			await workspace.operations(actor.headers, () =>
				createOrganization(workspace.auth, actor.headers, {
					name: "Execution measurements",
					slug: `execution-measurements-${locale}`,
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
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		const nodes = {
			a: (
				await createTestNode(workspace.database.db, reference, {
					hostname: "compute-a",
					machineId: "compute-a",
				})
			).nodeId,
			b: (
				await createTestNode(workspace.database.db, reference, {
					hostname: "compute-b",
					machineId: "compute-b",
				})
			).nodeId,
		};
		const second = 1_000_000_000n;
		const start =
			BigInt(Math.floor((Date.now() - 300_000) / 60_000) * 60_000) * 1_000_000n;
		const sample = (
			node: string,
			resource: string,
			metric: "process.cpu.time" | "recount.process.memory.rss",
			at: bigint,
			value: number,
		) =>
			telemetry.client.command({
				query: insertPoints({
					resource_id: "{resource:String}",
					resource_kind: "toUInt8(4)",
					metric_name: `'${metric}'`,
					...(metric === "process.cpu.time"
						? {
								metric_kind: "toUInt8(2)",
								temporality: "toUInt8(2)",
								monotonic: "CAST(1, 'Nullable(UInt8)')",
								unit: "'s'",
							}
						: { metric_kind: "toUInt8(1)", unit: "'By'" }),
				}),
				query_params: {
					project: project.id,
					source: node,
					host: node,
					resource,
					time: (start + at * second).toString(),
					integer: String(value),
					sample: randomUUID(),
					stream: `${node}/${resource}/${metric}`,
					epoch: "epoch",
				},
			});
		for (const [at, value] of [
			[0n, 0],
			[10n, 2],
			[20n, 4],
		] as const)
			await sample(nodes.a, "process-a", "process.cpu.time", at, value);
		await sample(nodes.a, "process-a", "recount.process.memory.rss", 10n, 1024);
		await sample(nodes.b, "process-b", "recount.process.memory.rss", 10n, 2048);
		const facts = [
			// compute-a is still running; compute-b ended at 30 s.
			{ node: nodes.a, resource: "process-a", pid: 42, ended: null },
			{ node: nodes.b, resource: "process-b", pid: 7, ended: 30n },
		].flatMap(({ node, resource, pid, ended }) => {
			const lifecycle = {
				...executionParticipant(project.id, "run:measured", {
					nodeId: node,
					firstSeen: start,
				}),
				last_seen_unix_nano: (start + 25n * second).toString(),
				ended_unix_nano:
					ended === null ? null : (start + ended * second).toString(),
			};
			return [
				lifecycle,
				{
					...lifecycle,
					fact_id: randomUUID(),
					kind: 2,
					process_resource_id: resource,
					process_namespace_id: "pidns:1",
					process_pid: pid,
					process_start_time_ticks: "100",
					execution_name: null,
					workload_version: null,
					parameters: [],
				},
			];
		});
		await telemetry.client.insert({
			table: "execution_participants",
			format: "JSONEachRow",
			values: facts,
		});
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.goto(
			`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions/${encodeURIComponent("run:measured")}`,
		);
		await expect(
			page.getByRole("button", {
				name: m.execution_timeline_live({}, { locale }),
				exact: true,
			}),
		).toBeVisible();
		for (const label of [
			m.metric_process_cpu_time({}, { locale }),
			m.metric_process_memory_rss({}, { locale }),
		])
			await expect(
				page.getByRole("heading", { name: label, exact: true }),
			).toBeVisible();
		const measurements = page.getByRole("region", {
			name: m.execution_timeline_measurements({}, { locale }),
		});
		await expect(measurements).toHaveAttribute("aria-busy", "false");
		const values = page.getByRole("table", {
			name: m.execution_timeline_values({}, { locale }),
		});
		const row = (metric: string, machine: string) =>
			values
				.getByRole("row")
				.filter({ hasText: metric })
				.filter({ hasText: machine });
		const cpu = m.metric_process_cpu_time({}, { locale });
		const memory = m.metric_process_memory_rss({}, { locale });
		const missing = m.no_recorded_value({}, { locale });
		// The latest values come from the last bucket with data: 20 s, where only CPU was read.
		await expect(values.getByRole("row")).toHaveCount(5);
		await expect(row(cpu, "compute-a")).toContainText(
			m.execution_timeline_unit_cores({}, { locale }),
		);
		await expect(row(cpu, "compute-a")).not.toContainText(missing);
		await expect(row(memory, "compute-a")).toContainText(missing);
		await expect(row(memory, "compute-b")).toContainText(missing);
		// The instant slider is keyboard operable and stored in the URL.
		const slider = page.getByRole("slider", {
			name: m.execution_timeline_instant({}, { locale }),
		});
		await slider.focus();
		await page.keyboard.press("Home");
		await expect(page).toHaveURL(
			new RegExp(
				`[?&]at=${encodeURIComponent(new Date(Number(start / 1_000_000n)).toISOString())}`,
			),
		);
		await expect(row(cpu, "compute-a")).toContainText(missing);
		for (let step = 0; step < 5; step++)
			await page.keyboard.press("ArrowRight");
		const tenSeconds = new Date(
			Number(start / 1_000_000n) + 10_000,
		).toISOString();
		await expect(page).toHaveURL(
			new RegExp(`[?&]at=${encodeURIComponent(tenSeconds)}`),
		);
		await expect(row(memory, "compute-a")).toContainText(
			formatValue(
				1024,
				{ unit: "auto" },
				{ unit: "By", calculation: "last" },
				locale,
			),
		);
		// Two CPU seconds over the 2-second bucket that ends the 10-second step.
		await expect(
			row(cpu, "compute-a")
				.getByRole("cell")
				.nth(2)
				.getByText(
					formatValue(
						1,
						{ unit: "auto" },
						{ unit: "s", calculation: "rate" },
						locale,
					),
					{ exact: true },
				),
		).toBeVisible();
		await expect(row(memory, "compute-a")).toContainText(
			m.unit_bytes({}, { locale }),
		);
		await expect(row(memory, "compute-b")).not.toContainText(missing);
		// Selecting a machine narrows the charts and values to it.
		await page
			.getByRole("button", {
				name: m.execution_timeline_select_machine(
					{ node: "compute-b" },
					{ locale },
				),
			})
			.click();
		await expect(page).toHaveURL(new RegExp(`[?&]node=${nodes.b}`));
		await expect(measurements).toHaveAttribute("aria-busy", "false");
		// The charts' legends name only the selected machine once its result loads.
		await expect(measurements).not.toContainText("compute-a");
		await expect(
			page.getByText(
				m.execution_timeline_scope_node({ node: "compute-b" }, { locale }),
			),
		).toBeVisible();
		await expect(values.getByRole("row")).toHaveCount(3);
		await expect(row(memory, "compute-b")).not.toContainText(missing);
		await expect(values).not.toContainText("compute-a");
		await page
			.getByRole("button", { name: m.execution_timeline_next({}, { locale }) })
			.click();
		await expect(page).toHaveURL(
			new RegExp(
				`[?&]at=${encodeURIComponent(new Date(Number(start / 1_000_000n) + 12_000).toISOString())}`,
			),
		);
		await expect(row(memory, "compute-b")).toContainText(missing);
		await page.screenshot({
			path: testInfo.outputPath(`execution-measurements-${locale}.png`),
			fullPage: true,
		});
	});
