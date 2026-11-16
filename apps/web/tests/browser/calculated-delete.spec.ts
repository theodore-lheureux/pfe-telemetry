import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { calculatedReference } from "../../src/analytics/calculated-metrics";
import {
	parseSaveCalculation,
	saveCalculation,
} from "../../src/analytics/calculated-metrics.server";
import type { MetricDefinition } from "../../src/analytics/contracts";
import {
	DEFAULT_DRAFT,
	encodeDraft,
	newSeries,
} from "../../src/analytics/insight/draft";
import { saveInsight } from "../../src/analytics/saved-insights.server";
import { calculatedMetric, metricAnnotation } from "../../src/db/schema";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { data, expect, test } from "./fixtures";

test.skip(
	!process.env.RECOUNT_CLICKHOUSE_URL,
	"Requires the reused ClickHouse for definition metadata reads; no telemetry is published",
);

test("custom calculation deletion confirms, cancels and refuses stale unused state", async ({
	page,
	workspace,
}) => {
	const actor = await workspace.signIn(
		page,
		`calculated-delete-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Calculated deletion",
				slug: `calculated-delete-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await workspace.operations(actor.headers, (actor) =>
			createProject(workspace.database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Calculated deletion",
			}),
		),
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	const create = async (name: string) =>
		data(
			await workspace.operations(actor.headers, (actor) =>
				saveCalculation(
					workspace.database.db,
					actor,
					parseSaveCalculation({
						...reference,
						create: true,
						id: randomUUID(),
						name,
						description: "",
						definition: {
							inputs: [
								{
									name: "A",
									metric: "test.delete.input",
									calculation: "avg",
									combine: "sum",
								},
							],
							expression: "A",
							unit: "1",
						},
					}),
					undefined,
					async () =>
						new Map([
							[
								"test.delete.input",
								{
									name: "test.delete.input",
									kind: 1,
									temporality: 0,
									monotonic: null,
									behavior: "gauge",
									unit: "1",
									description: "",
									firstSeen: new Date(0),
									lastSeen: new Date(0),
								} satisfies MetricDefinition,
							],
						]),
				),
			),
		);
	const definitionUrl = (id: string) =>
		`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/definitions/metrics/${calculatedReference(id)}`;
	const unused = await create("Disposable calculation");
	await workspace.database.db.insert(metricAnnotation).values({
		...reference,
		metricName: calculatedReference(unused.id),
		description: "Disposable annotation",
	});
	await page.goto(definitionUrl(unused.id));
	const remove = page.getByRole("button", { name: "Delete", exact: true });
	await expect(remove).toBeEnabled();
	await remove.click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("Disposable calculation");
	await confirmation
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(confirmation).toHaveCount(0);
	await expect(remove).toBeFocused();
	await remove.click();
	await confirmation
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect(page).toHaveURL(/\/definitions\/?$/);
	expect(
		await workspace.database.db
			.select()
			.from(calculatedMetric)
			.where(eq(calculatedMetric.id, unused.id)),
	).toHaveLength(0);
	expect(
		await workspace.database.db
			.select()
			.from(metricAnnotation)
			.where(eq(metricAnnotation.metricName, calculatedReference(unused.id))),
	).toHaveLength(0);

	const used = await create("Used calculation");
	await page.goto(definitionUrl(used.id));
	await expect(remove).toBeEnabled();
	data(
		await workspace.operations(actor.headers, (actor) =>
			saveInsight(workspace.database.db, actor, {
				...reference,
				insightId: randomUUID(),
				name: "New reference",
				draft: encodeDraft({
					...DEFAULT_DRAFT,
					series: [
						{
							...newSeries("A"),
							metric: calculatedReference(used.id),
							calculation: "last",
							combine: "sum",
						},
					],
				}),
			}),
		),
	);
	await remove.click();
	await confirmation
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect(confirmation).toContainText(
		"This metric is used by saved insights",
	);
	await expect(confirmation).toBeVisible();
	expect(
		await workspace.database.db
			.select()
			.from(calculatedMetric)
			.where(eq(calculatedMetric.id, used.id)),
	).toHaveLength(1);
	await confirmation
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await page.reload();
	await expect(remove).toBeDisabled();
	await page.goto(definitionUrl("cpu-usage"));
	await expect(remove).toHaveCount(0);
});
