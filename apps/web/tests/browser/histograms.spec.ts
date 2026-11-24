import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { m } from "@recount/i18n/messages";
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
const detail = "recount.process.memory.rss";
const coverage = "recount.collection.process.coverage";
const context = "histogram-context-evidence-test1";
const seconds = 1800;
const nodes = 4;
const bounds = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];

function histogramPoint(second: number, node: number, from: number) {
	const time = from + second * 1000;
	const counts = new Array<number>(bounds.length + 1).fill(0);
	const center = 2 + Math.floor(second / 360);
	const values = Array.from({ length: 120 }, (_, process) => {
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

const attr = (key: string, value: string) => [
	`/${key}`,
	2,
	value,
	null,
	null,
	null,
	null,
];
const hint = (key: string, value: string) =>
	attr(`recount.analytics.${key}`, value);

async function seedCoverage(
	insert: (table: string, row: Record<string, unknown>) => Promise<unknown>,
	source: string,
	from: number,
	to: number,
) {
	const seed = async (
		id: number,
		metric: string,
		unit: string,
		value: number,
		attributes: Record<string, unknown>,
	) => {
		const stream = `hist-extra-${id}`;
		await insert("metric_series", {
			source_id: source,
			resource_id: "node-1",
			host_id: "node-1",
			resource_kind: 1,
			metric_name: metric,
			metric_kind: 1,
			unit,
			series_id: String(id),
			logical_series_id: String(id),
			first_seen_unix_milli: String(from),
			last_seen_unix_milli: String(to - 1000),
			...attributes,
		});
		await insert("metric_streams", { stream_id: stream });
		await insert("metric_points", {
			metric_name: metric,
			series_id: String(id),
			stream_id: stream,
			time_unix_milli: String(to - 1000),
			event_day: Math.floor((to - 1000) / 86_400_000),
			value_kind: 1,
			int_value: String(value),
		});
	};
	for (const [pid, name, memory] of [
		[902, "python", 735_000_000],
		[901, "worker", 360_000_000],
	] as const) {
		await seed(pid, detail, "By", memory, {
			resource_kind: 2,
			resource_id: String(pid),
			resource_attributes: [
				attr("process.pid", String(pid)),
				attr("process.executable.name", name),
			],
			metric_metadata: [
				hint("section", "processes"),
				hint("breakdown", "process.pid"),
				hint("coverage.metric", coverage),
				hint("coverage.mode", "partial"),
				hint("coverage.omitted", "detail_deferred"),
				hint("coverage.shown", "detail_emitted"),
				hint("coverage.total", "verified"),
			],
		});
	}
	for (const [id, kind, count] of [
		[81001, "detail_emitted", 2],
		[81002, "verified", 124],
		[81003, "detail_deferred", 1],
	] as const) {
		await seed(id, coverage, "{process}", count, {
			point_attributes: [attr("coverage", kind)],
			metric_metadata: [hint("section", "diagnostics")],
		});
	}
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
			clickhouse_settings: { input_format_json_named_tuples_as_objects: 0 },
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
				unit: "1{busy_process}",
				metric_metadata: [
					hint("section", "processes"),
					hint("quantity", "cpu"),
					hint("coverage.metric", coverage),
					hint("coverage.mode", "excluded"),
					hint("coverage.omitted", "cpu_idle"),
					hint("coverage.reason", "idle"),
				],
				temporality: 1,
				series_id: String(77 + node),
				logical_series_id: String(77 + node),
				first_seen_unix_milli: String(from),
				last_seen_unix_milli: String(time),
			});
			await insert("metric_streams", { stream_id: streamFor(node) });
			await insert("metric_series", {
				source_id: project.id,
				resource_id: `node-${node + 1}`,
				host_id: `node-${node + 1}`,
				resource_kind: 1,
				metric_name: coverage,
				metric_kind: 1,
				unit: "{process}",
				point_attributes: [attr("coverage", "cpu_idle")],
				series_id: String(170 + node),
				logical_series_id: String(170 + node),
				first_seen_unix_milli: String(from),
				last_seen_unix_milli: String(time),
			});
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
		await seedCoverage(insert, project.id, from, to);
		await client.insert({
			table: "telemetry.metric_points",
			format: "JSONEachRow",
			values: Array.from({ length: (seconds / 60) * nodes }, (_, index) => {
				const bucket = from + Math.floor(index / nodes) * 60_000;
				return {
					project_id: project.id,
					metric_name: coverage,
					series_id: String(170 + (index % nodes)),
					stream_id: streamFor(index % nodes),
					time_unix_milli: String(bucket),
					event_day: Math.floor(bucket / 86_400_000),
					value_kind: 1,
					int_value: "35",
				};
			}),
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
			await expect(
				page.getByRole("option", { name: /^Process CPU(?!\s*usage)/ }),
			).toBeVisible();
			await page.screenshot({
				path: info.outputPath(`histogram-picker-${theme}.png`),
			});
			await page
				.getByRole("option", { name: /^Process CPU(?!\s*usage)/ })
				.click({ timeout: 6000 });
			// Histograms use the ordinary calculation menu, starting at p95.
			const calculation = page.getByRole("combobox", { name: "Calculation" });
			await expect(calculation).toHaveText("p95");
			await page.getByRole("button", { name: "Duplicate series A" }).click();
			await calculation.nth(1).click();
			await page.getByRole("option", { name: "p50", exact: true }).click();
			await expect(page.locator(".recharts-surface").first()).toBeVisible();
			await expect(
				page.getByRole("heading", { level: 2, name: "Process CPU" }),
			).toBeVisible();
			await expect(
				page.getByRole("row").filter({ hasText: /^p(50|95)/ }),
			).toHaveCount(2);
			await page.screenshot({
				path: info.outputPath(`histogram-percentiles-${theme}.png`),
			});
			await page.getByRole("combobox", { name: "Chart type" }).click();
			await page.getByRole("option", { name: "Heatmap" }).click();
			const plot = page.locator(".recharts-surface").first();
			await expect(plot.getByText("CPU per process")).toBeVisible();
			await expect(plot.getByText("50%", { exact: true })).toBeVisible();
			await expect(
				page.getByText("Busy processes", { exact: true }),
			).toBeVisible();
			await plot.hover();
			const tooltip = page.locator(".recharts-tooltip-wrapper");
			await expect(tooltip).toContainText(/\d+ busy processes/);
			await expect(tooltip).toContainText("CPU");
			await expect(tooltip).toContainText("(140 idle)");
			await page.screenshot({
				path: info.outputPath(`histogram-heatmap-${theme}.png`),
			});
			const grid = encodeDraft({
				...DEFAULT_DRAFT,
				series: [
					{
						name: "A",
						metric,
						calculation: "p95",
						combine: "sum",
						filters: [],
					},
				],
				groupBy: "host",
				range: { kind: "between", from: new Date(from), to: new Date(to) },
				display: { ...DEFAULT_DRAFT.display, type: "grid" },
			});
			await page.goto(
				`${path}/explore?q=${encodeURIComponent(JSON.stringify(grid))}`,
			);
			const host = page.getByRole("button", { name: "node-1", exact: true });
			await expect(host).toBeVisible();
			await page.screenshot({
				path: info.outputPath(`histogram-grid-${theme}.png`),
			});
			await host.click();
			await expect(
				page.locator(".recharts-surface").first().getByText("CPU per process"),
			).toBeVisible();

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
			await page.goto(
				`${path}/explore?q=${encodeURIComponent(JSON.stringify(q))}`,
			);
			await page.getByRole("combobox", { name: "Choose a metric" }).click();
			await page
				.getByRole("option", { name: /^Top processes · memory/ })
				.click();
			await expect(
				page.getByRole("row", { name: /python · 902/ }),
			).toBeVisible();
			await expect(page.getByText(m.metric_coverage_warning())).toBeVisible();
			await page
				.getByRole("button", { name: m.insight_metric_about() })
				.hover();
			await expect(page.getByRole("tooltip")).toContainText(
				"2 of 124 processes shown",
			);
			await page.screenshot({
				path: info.outputPath(`histogram-top-processes-${theme}.png`),
			});
		}
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: "fr", url: workspace.origin },
			]);
		await page.goto(
			`${path}/explore?q=${encodeURIComponent(JSON.stringify(q))}`,
		);
		await expect(page.locator("html")).toHaveAttribute("lang", "fr");
		await page
			.getByRole("combobox", {
				name: m.insight_metric_choose({}, { locale: "fr" }),
			})
			.click();
		await expect(
			page
				.getByRole("option", {
					name: new RegExp(m.metric_hist_process_cpu({}, { locale: "fr" })),
				})
				.first(),
		).toBeVisible();
		await page.screenshot({ path: info.outputPath("histogram-picker-fr.png") });
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
