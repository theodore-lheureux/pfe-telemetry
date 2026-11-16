import { and, asc, eq } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { collectorNode } from "../db/schema";
import {
	attributeSummaries,
	metricSummaries,
} from "../definitions/definitions.server";
import { getTelemetryClient } from "../executions/telemetry.server";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import {
	availableCalculations,
	calculatedCatalogMetric,
	calculatedReference,
	isCalculatedMetric,
} from "./calculated-metrics";
import {
	assertCalculationFields,
	calculatedDefinitions,
	calculationAttributes,
	resolveCalculation,
} from "./calculated-metrics.server";
import { calculatedPlan } from "./calculated-plan";
import { withAnalyticsSlot } from "./capacity.server";
import type {
	AttributeValuesInput,
	MetricAttributesInput,
	OverviewSection,
	QueryRange,
	RunQueryInput,
} from "./contracts";
import {
	listAttributes,
	listAttributeValues,
	listMetrics,
} from "./discovery.server";
import { buildOverviewSection } from "./overview.server";
import { runQuery } from "./runner.server";

type Database = ReturnType<typeof getDatabase>;
const MAX_NODE_NAMES = 1000;

// Revoked and deleted nodes keep their names so older telemetry stays readable.
/** The project's node names, for labelling results grouped by node. */
export function nodeNames(database: Database, input: ProjectReference) {
	return database
		.select({ id: collectorNode.id, hostname: collectorNode.hostname })
		.from(collectorNode)
		.where(
			and(
				eq(collectorNode.organizationId, input.organizationId),
				eq(collectorNode.projectId, input.projectId),
			),
		)
		.orderBy(asc(collectorNode.hostname))
		.limit(MAX_NODE_NAMES);
}

/** Any project reader may run analyses; the project comes only from authorization. */
export async function runAnalyticsQuery(
	database: Database,
	actor: Actor,
	input: RunQueryInput,
	signal?: AbortSignal,
	run = runQuery,
) {
	await requireProject(database, actor, input);
	return withAnalyticsSlot(database, input.organizationId, signal, async () => {
		const selected = input.query.measures.filter((measure) =>
			isCalculatedMetric(measure.metric),
		);
		if (!selected.length) return run(input.projectId, input.query, signal);
		const timeout = AbortSignal.timeout(10_000);
		const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const definitions = new Map(
			(await calculatedDefinitions(database, input)).map((definition) => [
				calculatedReference(definition.id),
				definition,
			]),
		);
		const selectedDefinitions = selected.map((measure) => {
			const definition = definitions.get(measure.metric);
			if (!definition)
				throw new OperationError("NOT_FOUND", "Calculated metric not found");
			return { measure, definition };
		});
		const plan = calculatedPlan(input.query, definitions);
		for (const { measure, definition } of selectedDefinitions) {
			await assertCalculationFields(
				input,
				definition,
				[
					...(input.query.groupBy ?? []),
					...(input.query.filters ?? []).map((filter) => filter.field),
					...(measure.filters ?? []).map((filter) => filter.field),
				],
				abort,
			);
		}
		return plan.finish(await run(input.projectId, plan.query, abort));
	});
}

/** The builder's vocabulary: discovered metrics and node display names. */
export async function analyticsCatalog(
	database: Database,
	actor: Actor,
	input: ProjectReference,
	signal?: AbortSignal,
) {
	await requireProject(database, actor, input);
	const [collected, nodes, summaries, calculated] = await Promise.all([
		withAnalyticsSlot(database, input.organizationId, signal, () =>
			listMetrics(getTelemetryClient(), input.projectId, signal),
		),
		nodeNames(database, input),
		metricSummaries(database, input),
		calculatedDefinitions(database, input),
	]);
	const raw = collected.filter((metric) => !isCalculatedMetric(metric.name));
	const metrics = [
		...raw,
		...availableCalculations(calculated, raw).map(calculatedCatalogMetric),
	];
	// Hidden metrics stay in the catalog, so insights that already use them keep working.
	return {
		metrics: metrics.map((metric) => {
			const summary = summaries.get(metric.name);
			return {
				...metric,
				...(summary?.status ? { status: summary.status } : {}),
				...(summary?.note ? { note: summary.note } : {}),
				...(summary?.defaultBreakdown
					? { defaultBreakdown: summary.defaultBreakdown }
					: {}),
			};
		}),
		nodes,
	};
}

export async function metricAttributes(
	database: Database,
	actor: Actor,
	input: MetricAttributesInput,
	signal?: AbortSignal,
) {
	await requireProject(database, actor, input);
	const calculation =
		input.metric && isCalculatedMetric(input.metric)
			? await resolveCalculation(database, input, input.metric)
			: null;
	const [attributes, summaries] = await Promise.all([
		withAnalyticsSlot(database, input.organizationId, signal, () =>
			calculation
				? calculationAttributes(input, calculation, signal)
				: listAttributes(
						getTelemetryClient(),
						input.projectId,
						input.metric,
						signal,
					),
		),
		attributeSummaries(database, input),
	]);
	return attributes.map((attribute) => {
		const summary = summaries.get(`${attribute.scope}/${attribute.key}`);
		return {
			...attribute,
			...(summary?.status ? { status: summary.status } : {}),
			...(summary?.note ? { note: summary.note } : {}),
		};
	});
}

export async function attributeValues(
	database: Database,
	actor: Actor,
	input: AttributeValuesInput,
	signal?: AbortSignal,
) {
	await requireProject(database, actor, input);
	const calculation =
		input.metric && isCalculatedMetric(input.metric)
			? await resolveCalculation(database, input, input.metric)
			: null;
	if (calculation)
		await withAnalyticsSlot(database, input.organizationId, signal, () =>
			assertCalculationFields(input, calculation, [input.field], signal),
		);
	return withAnalyticsSlot(database, input.organizationId, signal, () =>
		listAttributeValues(
			getTelemetryClient(),
			input.projectId,
			input.field,
			calculation?.inputs[0].metric ?? input.metric,
			signal,
		),
	);
}

/** One section of the fixed fleet overview; readers see it for any project they can open. */
export async function overviewSection(
	database: Database,
	actor: Actor,
	input: ProjectReference & { range: QueryRange; section: OverviewSection },
	signal?: AbortSignal,
) {
	await requireProject(database, actor, input);
	const result = await withAnalyticsSlot(
		database,
		input.organizationId,
		signal,
		() =>
			buildOverviewSection(input.projectId, input.range, input.section, signal),
	);
	if (!result) return null;
	const names = new Map(
		(await nodeNames(database, input)).map((node) => [node.id, node.hostname]),
	);
	return {
		...result,
		nodes: result.nodes.map((node) => ({
			...node,
			hostname: names.get(node.id) ?? null,
		})),
	};
}
