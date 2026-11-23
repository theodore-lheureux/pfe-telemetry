import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { DEFAULT_DRAFT, encodeDraft } from "../../src/analytics/insight/draft";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { data, expect, test } from "./fixtures";
import { clearTelemetry } from "./telemetry-seed";

test.skip(
	process.env.RECOUNT_ACTIVITY_TEST_ALLOW_PUBLISH !== "1",
	"Requires disposable telemetry project permission",
);

const metric = "recount.node.process.cpu.utilization.distribution";
const context = "histogram-context-evidence-test1";
const seconds = 1800;
const nodes = 4;
const bounds = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];

function histogramPoint(second: number, node: number, from: number) {
	const time = from + second * 1000;
	const counts = new Array<number>(bounds.length + 1).fill(0);
	const center = 2 + Math.floor(second / 360);
	const values = Array.from({ length: 120 }, (_, process) => {
		if (process < 35) return 0;
		const skew = ((process * 17 + second * 7 + node * 13) % 11) - 5;
		const bucket = Math.min(11, Math.max(1, center + Math.round(skew / 2)));
		return bounds[bucket];
	});
	for (const value of values) counts[bounds.indexOf(value)]++;
	return {
		metric_name: metric,
		series_id: String(77 + node),
		stream_id: streamFor(node),
		time_unix_milli: String(time),
		event_day: Math.floor(time / 86_400_000),
		raw_offset: second + 1,
		statistics_present: 15,
		count: values.length,
		sum: values.reduce((total, value) => total + value, 0),
		min: Math.min(...values),
		max: Math.max(...values),
		explicit_bounds: bounds,
		bucket_counts: counts,
	};
}

function streamFor(node: number) {
	return `histogram-test0${node}`;
}

test("Explore pools matching buckets and Explorer exposes the stored buckets", async ({
	page,
	workspace,
}, info) => {
	const actor = await workspace.signIn(
		page,
		`histograms-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Distributions lab",
				slug: `distributions-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await workspace.operations(actor.headers, (actor) =>
			createProject(workspace.database.db, actor, {
				organizationId: organization.id,
				requestId: randomUUID(),
				name: "Cluster",
			}),
		),
	);
	const client = createClient({
		url: process.env.RECOUNT_CLICKHOUSE_TEST_URL,
		username: process.env.RECOUNT_CLICKHOUSE_TEST_USER,
		password: process.env.RECOUNT_CLICKHOUSE_TEST_PASSWORD,
	});
	const to = Math.floor((Date.now() - 5000) / 1000) * 1000;
	const from = to - seconds * 1000;
	const time = to - 1000;
	const insert = (table: string, row: Record<string, unknown>) =>
		client.insert({
			table: `telemetry.${table}`,
			values: [{ project_id: project.id, ...row }],
			format: "JSONEachRow",
		});
	try {
		for (let node = 0; node < nodes; node++) {
			await insert("metric_series", {
				source_id: project.id,
				resource_id: `node-${node + 1}`,
				host_id: `node-${node + 1}`,
				resource_kind: 1,
				metric_name: metric,
				metric_kind: 3,
				unit: "1",
				temporality: 1,
				series_id: String(77 + node),
				logical_series_id: String(77 + node),
				first_seen_unix_milli: String(from),
				last_seen_unix_milli: String(time),
			});
			await insert("metric_streams", { stream_id: streamFor(node) });
		}
		await insert("deliveries", {
			source_id: project.id,
			raw_offset: seconds,
			received_unix_nano: String(BigInt(time + 1) * 1_000_000n),
			min_event_unix_milli: String(time),
			max_event_unix_milli: String(time),
			delivery_context_id: context,
			delivery_request: Buffer.from("1a0178", "hex").toString(),
		});
		await insert("delivery_contexts", {
			source_id: project.id,
			delivery_context_id: context,
			delivery_context: Buffer.from("1200", "hex").toString(),
		});
		await client.insert({
			table: "telemetry.metric_points",
			format: "JSONEachRow",
			values: Array.from({ length: seconds * nodes }, (_, index) => ({
				project_id: project.id,
				...histogramPoint(Math.floor(index / nodes), index % nodes, from),
			})),
		});
		const path = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}`;
		const q = encodeDraft({
			...DEFAULT_DRAFT,
			range: { kind: "between", from: new Date(from), to: new Date(to) },
		});
		await page.setViewportSize({ width: 1440, height: 1050 });
		for (const theme of ["light", "dark"] as const) {
			const preference = theme === "dark" ? "tide-dark" : "tide";
			await page.context().addCookies([
				{ name: "recount_locale", value: "en", url: workspace.origin },
				{
					name: "recount_theme",
					value: preference,
					url: workspace.origin,
				},
			]);
			await page.goto(
				`${path}/explore?q=${encodeURIComponent(JSON.stringify(q))}`,
			);
			await expect(page.locator("html")).toHaveAttribute("lang", "en");
			await expect(page.locator("html")).toHaveAttribute(
				"data-theme",
				preference,
			);
			const later = page.getByRole("dialog", { name: /passkey/i });
			if (await later.isVisible())
				await later.getByRole("button", { name: /later/i }).click();
			await page
				.getByRole("combobox", { name: "Choose a metric" })
				.click({ timeout: 6000 });
			await page
				.getByRole("option", { name: /Process CPU distribution/i })
				.click({ timeout: 6000 });
			await expect(page.getByLabel("Histogram percentile")).toHaveCount(1);
			for (const percentile of ["p50", "p95", "p99"])
				await expect(
					page.getByRole("button", { name: percentile, exact: true }),
				).toHaveAttribute("aria-pressed", "true");
			await expect(page.locator(".recharts-surface").first()).toBeVisible();
			await expect(
				page.getByRole("row").filter({ hasText: "Process CPU distribution" }),
			).toHaveCount(3);
			await page.getByRole("combobox", { name: "Chart type" }).click();
			await page.getByRole("option", { name: "Heatmap" }).click();
			await expect(
				page.locator("svg [data-time-window]").first(),
			).toBeVisible();
			await expect(
				page.locator("[data-time-window] rect title").first(),
			).toContainText("Count:");
			await expect(page.getByLabel("Time slice")).toHaveCount(0);
			const cell = page.locator("[data-time-window] rect").first();
			await cell.hover();
			const tooltip = page.getByRole("tooltip");
			await expect(tooltip).toContainText(
				/\d.*[–-].*\d.*%.*Count:.*of this time bucket/,
			);
			await page.screenshot({
				path: info.outputPath(`histogram-heatmap-${theme}.png`),
			});
			await page.getByRole("combobox", { name: "Chart type" }).click();
			await page.getByRole("option", { name: "Node grid" }).click();
			const host = page
				.getByRole("button", { name: /Open node heatmap: node-/ })
				.first();
			await expect(host).toBeVisible();
			await page.screenshot({
				path: info.outputPath(`histogram-grid-${theme}.png`),
			});
			await host.click();
			await expect(page.locator("[data-time-window]").first()).toBeVisible();

			await page.goto(`${path}/activity`);
			await page
				.getByRole("button", { name: `Inspect ${metric}` })
				.first()
				.click();
			await expect(page.getByRole("tab", { name: "Buckets" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			const panel = page.getByRole("tabpanel");
			await expect(panel).toContainText("120");
			await panel
				.locator("..")
				.evaluate((element) => element.scrollIntoView({ block: "start" }));
			const header = await page
				.getByRole("heading", { name: "Activity", exact: true })
				.boundingBox();
			const tabs = await page
				.getByRole("tablist", { name: "Telemetry details" })
				.boundingBox();
			expect(tabs?.y ?? 0).toBeGreaterThan(
				(header?.y ?? 0) + (header?.height ?? 0),
			);
			await page.screenshot({
				path: info.outputPath(`histogram-explorer-${theme}.png`),
			});
		}
	} finally {
		await clearTelemetry(client, project.id);
		for (const table of ["metric_streams", "delivery_contexts"])
			await client.command({
				query: `ALTER TABLE telemetry.${table} DELETE WHERE project_id = {project:String} SETTINGS mutations_sync = 1`,
				query_params: { project: project.id },
			});
		await client.close();
	}
});
