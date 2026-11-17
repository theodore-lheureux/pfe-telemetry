import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { m } from "@recount/i18n/messages";
import { rangeLabel } from "../../src/components/date-range/date-range";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { executionParticipant } from "../execution-participant";
import { insertMetricPoint } from "../telemetry/fixture";
import { data, expect } from "./fixtures";
import { test } from "./telemetry-fixtures";

const key = "run:dashboard";
test.use({ timezoneId: "UTC" });
const second = 1_000_000_000n;

type Telemetry = Parameters<Parameters<typeof test>[2]>[0]["telemetry"];

/** An execution over two minutes: one member process and one unrelated process. */
async function record(telemetry: Telemetry, project: string, start: bigint) {
	const node = randomUUID();
	const point = (
		metric: string,
		at: bigint,
		value: number,
		options: Omit<
			Parameters<typeof insertMetricPoint>[1],
			"project" | "node" | "metric" | "time" | "value"
		> = {},
	) =>
		insertMetricPoint(telemetry.client, {
			project,
			node,
			metric,
			time: start + at * second,
			value,
			...options,
		});
	for (const [resource, values] of [
		["process-a", [0, 2, 6]],
		["process-c", [0, 50, 100]],
	] as const)
		for (const [index, at] of [0n, 60n, 120n].entries())
			await point("process.cpu.time", at, values[index], {
				resource,
				counter: true,
			});
	await point("recount.process.memory.rss", 0n, 1024, {
		resource: "process-a",
	});
	await point("recount.process.memory.rss", 60n, 4096, {
		resource: "process-a",
	});
	for (const [direction, total] of [
		["read", 2048],
		["write", 1024],
	] as const)
		for (const [at, value] of [
			[0n, 0],
			[120n, total],
		] as const)
			await point("process.disk.io", at, value, {
				resource: "process-a",
				counter: true,
				attributes: { "disk.io.direction": direction },
			});
	for (const [mode, total] of [
		["user", 60],
		["idle", 60],
	] as const)
		for (const [at, value] of [
			[0n, 0],
			[120n, total],
		] as const)
			await point("recount.node.cpu.time", at, value, {
				counter: true,
				attributes: { "cpu.mode": mode },
			});
	for (const [at, value] of [
		[0n, 0],
		[120n, 4096],
	] as const)
		await point("system.disk.io", at, value, { counter: true });
	await point("recount.node.memory.total", 60n, 8192);
	await point("recount.node.memory.available", 60n, 2048);
	await telemetry.client.insert({
		table: "execution_participants",
		format: "JSONEachRow",
		values: [
			executionParticipant(project, key, {
				nodeId: node,
				name: "Training run",
				firstSeen: start,
			}),
			{
				...executionParticipant(project, key, {
					nodeId: node,
					firstSeen: start,
				}),
				kind: 2,
				process_resource_id: "process-a",
				process_namespace_id: "pidns:1",
				process_pid: 42,
				process_start_time_ticks: "100",
				execution_name: null,
				workload_version: null,
				parameters: [],
				last_seen_unix_nano: (start + 120n * second).toString(),
			},
		],
	});
}

async function openExecutionDashboard(
	page: Page,
	origin: string,
	path: string,
	locale: "en" | "fr",
) {
	await page.goto(`${origin}${path}/executions/${encodeURIComponent(key)}`);
	await page
		.getByRole("link", {
			name: m.execution_dashboard_open({}, { locale }),
			exact: true,
		})
		.click();
	await expect(page).toHaveURL(/\/executions\/[^/]+\/dashboard$/);
	await expect(
		page.getByRole("heading", { level: 1, name: "Training run" }),
	).toBeVisible();
}

for (const locale of ["en", "fr"] as const)
	test(`an execution opens its dashboard over its period with totals (${locale})`, async ({
		page,
		workspace,
		telemetry,
	}, testInfo) => {
		const options = { locale };
		const actor = await workspace.signIn(
			page,
			`execution-dashboard-${randomUUID()}@example.invalid`,
		);
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		const organization = data(
			await workspace.operations(actor.headers, () =>
				createOrganization(workspace.auth, actor.headers, {
					name: "Execution dashboards",
					slug: `execution-dashboards-${randomUUID()}`,
				}),
			),
		);
		const project = data(
			await workspace.operations(actor.headers, (actor) =>
				createProject(workspace.database.db, actor, {
					requestId: randomUUID(),
					organizationId: organization.id,
					name: "Training",
				}),
			),
		);
		const start =
			BigInt(Math.floor((Date.now() - 600_000) / 1000)) * 1000n * 1_000_000n;
		await record(telemetry, project.id, start);
		const path = `/organizations/${organization.id}/projects/${project.id}`;
		await openExecutionDashboard(page, workspace.origin, path, locale);

		await expect(
			page.getByText(m.execution_dashboard_notice({}, options), {
				exact: false,
			}),
		).toBeVisible();
		// The range is the execution's period in whole minutes, through its last observation.
		const minute = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000);
		const first = Number(start / 1_000_000n);
		const period = rangeLabel(
			{
				kind: "between",
				from: minute(first),
				to: new Date(minute(first + 120_000).getTime() + 60_000),
			},
			locale,
			"UTC",
		);
		await expect(
			page.getByRole("button", {
				name: `${m.insight_range({}, options)}: ${period}`,
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByText(`${m.execution_field({}, options)} = ${key}`, {
				exact: true,
			}),
		).toBeVisible();
		const article = (name: string) =>
			page.getByRole("article", { name, exact: true });
		await expect(page.getByRole("article")).toHaveCount(12);
		for (const [name, value] of [
			[m.dashboard_template_execution_cpu_time({}, options), /^6\s?s$/],
			[
				m.dashboard_template_execution_peak_memory({}, options),
				/^4(\.0)?\s?KiB$/,
			],
			[
				m.dashboard_template_execution_disk_read({}, options),
				/^2(\.0)?\s?KiB$/,
			],
			[
				m.dashboard_template_execution_disk_written({}, options),
				/^1(\.0)?\s?KiB$/,
			],
		] as const)
			await expect(
				article(name).locator("span.tabular-nums").first(),
			).toHaveText(value);
		await expect(
			article(m.dashboard_template_execution_node_cpu({}, options)),
		).toBeVisible();
		await expect(
			page.getByText(m.dashboard_template_panel_unavailable({}, options)),
		).toHaveCount(0);
		await page.screenshot({
			path: testInfo.outputPath(`execution-dashboard-${locale}.png`),
			fullPage: true,
		});
		if (locale === "fr") return;

		// The saved dashboard keeps the execution and its period.
		await page
			.getByRole("button", {
				name: m.dashboard_template_create_dashboard({}, options),
				exact: true,
			})
			.click();
		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByLabel(m.execution_key({}, options), { exact: true }),
		).toHaveValue(key);
		await expect(
			dialog.getByLabel(m.dashboard_name({}, options), { exact: true }),
		).toHaveValue("Training run");
		await dialog
			.getByRole("button", { name: m.saved_save({}, options), exact: true })
			.click();
		await expect(page).toHaveURL(/\/dashboards\/[0-9a-f-]{36}$/);
		await expect(
			page.getByRole("heading", { level: 1, name: "Training run" }),
		).toBeVisible();
		await expect(
			article(m.dashboard_template_execution_cpu_time({}, options))
				.locator("span.tabular-nums")
				.first(),
		).toHaveText(/^6\s?s$/);
		await expect(
			page.getByText(`${m.execution_field({}, options)} = ${key}`, {
				exact: true,
			}),
		).toBeVisible();
	});
