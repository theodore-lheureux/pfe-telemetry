import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { data, expect, test } from "./fixtures";
import { clearTelemetry } from "./telemetry-seed";

test.skip(
	process.env.RECOUNT_ACTIVITY_TEST_ALLOW_PUBLISH !== "1",
	"Requires disposable telemetry project permission",
);

const metric = "recount.node.process.cpu.utilization.distribution";
const stream = "histogram-test01";
const context = "histogram-context-evidence-test1";

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
	const time = Date.now() - 45_000;
	const insert = (table: string, row: Record<string, unknown>) =>
		client.insert({
			table: `telemetry.${table}`,
			values: [{ project_id: project.id, ...row }],
			format: "JSONEachRow",
		});
	try {
		await insert("metric_series", {
			source_id: project.id,
			resource_id: "node-test",
			host_id: "node-test",
			resource_kind: 1,
			metric_name: metric,
			metric_kind: 3,
			unit: "1",
			temporality: 1,
			series_id: "77",
			logical_series_id: "77",
			first_seen_unix_milli: String(time - 1),
			last_seen_unix_milli: String(time),
		});
		await insert("metric_streams", { stream_id: stream });
		await insert("deliveries", {
			source_id: project.id,
			raw_offset: 1,
			received_unix_nano: String(BigInt(time + 1) * 1_000_000n),
			min_event_unix_milli: String(time - 1),
			max_event_unix_milli: String(time),
			delivery_context_id: context,
			delivery_request: Buffer.from("1a0178", "hex").toString(),
		});
		await insert("delivery_contexts", {
			source_id: project.id,
			delivery_context_id: context,
			delivery_context: Buffer.from("1200", "hex").toString(),
		});
		for (const t of [time, time - 1, time - 20_000]) {
			await insert("metric_points", {
				metric_name: metric,
				series_id: "77",
				stream_id: stream,
				time_unix_milli: String(t),
				event_day: Math.floor(t / 86_400_000),
				raw_offset: 1,
				statistics_present: 15,
				count: 3,
				sum: 3.5,
				min: 0,
				max: 2,
				explicit_bounds: [0, 0.5, 1],
				bucket_counts: [1, 0, 1, 1],
			});
		}
		const path = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}`;
		await page.goto(`${path}/explore`);
		const later = page.getByRole("dialog", { name: /passkey/i });
		if (await later.isVisible())
			await later.getByRole("button", { name: /later/i }).click();
		const picker = page.getByLabel("Distribution over time");
		await expect(picker).toBeEnabled();
		await picker.selectOption(JSON.stringify([metric, "1"]));
		const count = page.getByRole("row", { name: /^Count/ });
		await expect(count).toBeVisible();
		expect(
			(await count.getByRole("cell").allTextContents()).reduce(
				(total, value) => total + Number(value),
				0,
			),
		).toBe(9);
		await expect(page.getByRole("row", { name: /^Mean/ })).toContainText(
			"1.1666667",
		);
		await page
			.getByRole("table")
			.filter({ hasText: "Bucket" })
			.screenshot({ path: info.outputPath("histogram-heatmap.png") });
		await page.goto(`${path}/activity`);
		await page
			.getByRole("button", { name: `Inspect ${metric}` })
			.first()
			.click();
		await expect(page.getByRole("row", { name: /^Count/ })).toContainText("3");
		await page
			.getByRole("tabpanel")
			.screenshot({ path: info.outputPath("histogram-explorer.png") });
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: "fr", url: workspace.origin },
			]);
		await page.goto(`${path}/explore`);
		const frenchPicker = page.getByLabel("Distribution dans le temps");
		await expect(frenchPicker).toBeEnabled();
		await frenchPicker.selectOption(JSON.stringify([metric, "1"]));
		await expect(page.getByRole("row", { name: /^Moyenne/ })).toBeVisible();
		await page
			.getByRole("table")
			.filter({ hasText: "Classe" })
			.screenshot({ path: info.outputPath("histogram-heatmap-fr.png") });
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
