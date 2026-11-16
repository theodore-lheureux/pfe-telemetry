import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
	availableCalculations,
	calculatedCatalogMetric,
	isCalculatedMetric,
} from "../analytics/calculated-metrics";
import {
	assertCalculationFields,
	calculatedDefinitions,
	calculationAttributes,
	resolveCalculation,
} from "../analytics/calculated-metrics.server";
import { lockCalculatedMetrics } from "../analytics/calculated-references.server";
import { withAnalyticsSlot } from "../analytics/capacity.server";
import type { MetricDefinition } from "../analytics/contracts";
import {
	attributeValueSample,
	listAttributeCatalog,
	listMetrics,
	metricAttributeExamples,
	metricDefinitions,
} from "../analytics/discovery.server";
import { parseAttributeField } from "../analytics/fields";
import { person } from "../analytics/saved-insights.server";
import type { getDatabase } from "../db/client.server";
import {
	attributeAnnotation,
	dashboard,
	dashboardTile,
	member,
	metricAnnotation,
	projectMember,
	savedInsight,
	user,
} from "../db/schema";
import { getTelemetryClient } from "../executions/telemetry.server";
import { OperationError } from "../lib/operation-error";
import {
	type Actor,
	requireProject,
	resolveOrganizationRole,
	resolveProjectRole,
} from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import type {
	Annotation,
	AttributeDetail,
	AttributeEntry,
	AttributeReference,
	MetricDetail,
	MetricEntry,
	MetricInsight,
	MetricReference,
	UpdateAttributeInput,
	UpdateMetricInput,
} from "./contracts";

type Database = ReturnType<typeof getDatabase>;
type CatalogAttribute = Awaited<
	ReturnType<typeof listAttributeCatalog>
>[number];

const editor = alias(user, "editor");
const owner = alias(user, "owner");
const NO_ANNOTATION: Annotation = {
	description: "",
	tags: [],
	status: null,
	updatedAt: null,
	updatedBy: null,
};
const MAX_INSIGHTS = 100;

function metricsInProject(reference: ProjectReference) {
	return and(
		eq(metricAnnotation.organizationId, reference.organizationId),
		eq(metricAnnotation.projectId, reference.projectId),
	);
}

function attributesInProject(reference: ProjectReference) {
	return and(
		eq(attributeAnnotation.organizationId, reference.organizationId),
		eq(attributeAnnotation.projectId, reference.projectId),
	);
}

async function metricAnnotations(
	database: Database,
	reference: ProjectReference,
	metric?: string,
) {
	const rows = await database
		.select({
			metricName: metricAnnotation.metricName,
			description: metricAnnotation.description,
			tags: metricAnnotation.tags,
			status: metricAnnotation.status,
			defaultBreakdown: metricAnnotation.defaultBreakdown,
			updatedAt: metricAnnotation.updatedAt,
			editorId: editor.id,
			editorName: editor.name,
			editorEmail: editor.email,
			editorImage: editor.image,
			ownerId: owner.id,
			ownerName: owner.name,
			ownerEmail: owner.email,
			ownerImage: owner.image,
		})
		.from(metricAnnotation)
		.leftJoin(editor, eq(editor.id, metricAnnotation.updatedBy))
		.leftJoin(owner, eq(owner.id, metricAnnotation.ownerId))
		.where(
			metric === undefined
				? metricsInProject(reference)
				: and(
						metricsInProject(reference),
						eq(metricAnnotation.metricName, metric),
					),
		);
	return new Map(
		rows.map((row) => [
			row.metricName,
			{
				description: row.description,
				tags: row.tags,
				status: row.status,
				defaultBreakdown: row.defaultBreakdown,
				updatedAt: row.updatedAt,
				updatedBy: person(
					row.editorId,
					row.editorName,
					row.editorEmail,
					row.editorImage,
				),
				owner: person(
					row.ownerId,
					row.ownerName,
					row.ownerEmail,
					row.ownerImage,
				),
			},
		]),
	);
}

async function attributeAnnotations(
	database: Database,
	reference: ProjectReference,
	only?: { scope: AttributeEntry["scope"]; key: string },
) {
	const rows = await database
		.select({
			scope: attributeAnnotation.scope,
			key: attributeAnnotation.attributeKey,
			description: attributeAnnotation.description,
			tags: attributeAnnotation.tags,
			status: attributeAnnotation.status,
			updatedAt: attributeAnnotation.updatedAt,
			editorId: editor.id,
			editorName: editor.name,
			editorEmail: editor.email,
			editorImage: editor.image,
		})
		.from(attributeAnnotation)
		.leftJoin(editor, eq(editor.id, attributeAnnotation.updatedBy))
		.where(
			only
				? and(
						attributesInProject(reference),
						eq(attributeAnnotation.scope, only.scope),
						eq(attributeAnnotation.attributeKey, only.key),
					)
				: attributesInProject(reference),
		);
	return new Map<string, Annotation>(
		rows.map((row) => [
			`${row.scope}/${row.key}`,
			{
				description: row.description,
				tags: row.tags,
				status: row.status,
				updatedAt: row.updatedAt,
				updatedBy: person(
					row.editorId,
					row.editorName,
					row.editorEmail,
					row.editorImage,
				),
			},
		]),
	);
}

type MetricAnnotation =
	Awaited<ReturnType<typeof metricAnnotations>> extends Map<string, infer T>
		? T
		: never;

function metricEntry(
	definition: MetricDefinition,
	annotation: MetricAnnotation | undefined,
): MetricEntry {
	const { owner, defaultBreakdown, ...added } = annotation ?? {
		...NO_ANNOTATION,
		owner: null,
		defaultBreakdown: null,
	};
	return {
		...added,
		name: definition.name,
		label: definition.label,
		calculated: definition.calculated,
		kind: definition.kind,
		behavior: definition.behavior,
		unit: definition.unit,
		collectedDescription: definition.description,
		owner,
		defaultBreakdown,
		firstSeen: definition.firstSeen,
		lastSeen: definition.lastSeen,
	};
}

function attributeEntry(
	attribute: CatalogAttribute,
	annotations: Map<string, Annotation>,
): AttributeEntry {
	return {
		...attribute,
		...(annotations.get(`${attribute.scope}/${attribute.key}`) ??
			NO_ANNOTATION),
	};
}

/** Every metric the project has sent, once each, with what members added to it. */
export async function listMetricEntries(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
	signal?: AbortSignal,
): Promise<MetricEntry[]> {
	await requireProject(database, actor, reference);
	return metricEntries(database, reference, signal);
}

async function metricEntries(
	database: Database,
	reference: ProjectReference,
	signal?: AbortSignal,
) {
	const [collected, added, calculations] = await Promise.all([
		withAnalyticsSlot(database, reference.organizationId, signal, () =>
			listMetrics(getTelemetryClient(), reference.projectId, signal),
		),
		metricAnnotations(database, reference),
		calculatedDefinitions(database, reference),
	]);
	const raw = collected.filter((metric) => !isCalculatedMetric(metric.name));
	const definitions = [
		...raw,
		...availableCalculations(calculations, raw).map(calculatedCatalogMetric),
	];
	// The catalog lists a name's newest variant first; the definitions describe that one.
	const seen = new Set<string>();
	return definitions.flatMap((definition) => {
		if (seen.has(definition.name)) return [];
		seen.add(definition.name);
		return [metricEntry(definition, added.get(definition.name))];
	});
}

export async function listAttributeEntries(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
	signal?: AbortSignal,
): Promise<AttributeEntry[]> {
	await requireProject(database, actor, reference);
	const [attributes, annotations] = await Promise.all([
		withAnalyticsSlot(database, reference.organizationId, signal, () =>
			listAttributeCatalog(
				getTelemetryClient(),
				reference.projectId,
				undefined,
				signal,
			),
		),
		attributeAnnotations(database, reference),
	]);
	return attributes.map((attribute) => attributeEntry(attribute, annotations));
}

async function metricAttributes(
	database: Database,
	reference: MetricReference,
	signal?: AbortSignal,
) {
	if (isCalculatedMetric(reference.metric)) {
		const definition = await resolveCalculation(
			database,
			reference,
			reference.metric,
		);
		const [attributes, annotations] = await Promise.all([
			withAnalyticsSlot(database, reference.organizationId, signal, () =>
				calculationAttributes(reference, definition, signal),
			),
			attributeAnnotations(database, reference),
		]);
		return attributes.map((attribute) => ({
			...attributeEntry(attribute, annotations),
			example: null,
		}));
	}
	// Both reads are small, so they share one slot rather than holding two at once.
	const [[attributes, examples], annotations] = await Promise.all([
		withAnalyticsSlot(database, reference.organizationId, signal, async () => {
			const client = getTelemetryClient();
			const catalog = await listAttributeCatalog(
				client,
				reference.projectId,
				reference.metric,
				signal,
			);
			return [
				catalog,
				await metricAttributeExamples(
					client,
					reference.projectId,
					reference.metric,
					signal,
				),
			] as const;
		}),
		attributeAnnotations(database, reference),
	]);
	return attributes.map((attribute) => ({
		...attributeEntry(attribute, annotations),
		example: examples.get(`${attribute.scope}/${attribute.key}`) ?? null,
	}));
}

/** One metric's attributes with what members added and a recent value of each. */
export async function listMetricAttributeEntries(
	database: Database,
	actor: Actor,
	reference: MetricReference,
	signal?: AbortSignal,
): Promise<AttributeEntry[]> {
	await requireProject(database, actor, reference);
	return metricAttributes(database, reference, signal);
}

/** Saved insights whose series chart the metric, with the dashboards showing them. */
async function metricInsights(
	database: Database,
	reference: MetricReference,
): Promise<MetricInsight[]> {
	const creator = alias(user, "creator");
	const insights = await database
		.select({
			id: savedInsight.id,
			name: savedInsight.name,
			description: savedInsight.description,
			updatedAt: savedInsight.updatedAt,
			creatorId: creator.id,
			creatorName: creator.name,
			creatorEmail: creator.email,
			creatorImage: creator.image,
		})
		.from(savedInsight)
		.leftJoin(creator, eq(creator.id, savedInsight.createdBy))
		.where(
			and(
				eq(savedInsight.organizationId, reference.organizationId),
				eq(savedInsight.projectId, reference.projectId),
				sql`${savedInsight.draft}->'series' @> ${JSON.stringify([{ metric: reference.metric }])}::jsonb`,
			),
		)
		.orderBy(desc(savedInsight.updatedAt))
		.limit(MAX_INSIGHTS);
	const tiles = insights.length
		? await database
				.selectDistinct({
					insightId: dashboardTile.insightId,
					id: dashboard.id,
					name: dashboard.name,
				})
				.from(dashboardTile)
				.innerJoin(dashboard, eq(dashboard.id, dashboardTile.dashboardId))
				.where(
					and(
						eq(dashboardTile.projectId, reference.projectId),
						inArray(
							dashboardTile.insightId,
							insights.map((insight) => insight.id),
						),
					),
				)
				.orderBy(asc(dashboard.name))
		: [];
	return insights.map(
		({ creatorId, creatorName, creatorEmail, creatorImage, ...insight }) => ({
			...insight,
			createdBy: person(creatorId, creatorName, creatorEmail, creatorImage),
			dashboards: tiles
				.filter((tile) => tile.insightId === insight.id)
				.map(({ id, name }) => ({ id, name })),
		}),
	);
}

/** Everyone who can open the project: its members and the organization's owners and admins. */
async function projectPeople(database: Database, reference: ProjectReference) {
	const rows = await database
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			image: user.image,
			role: member.role,
			assignedRole: projectMember.role,
		})
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.leftJoin(
			projectMember,
			and(
				eq(projectMember.memberId, member.id),
				eq(projectMember.projectId, reference.projectId),
			),
		)
		.where(eq(member.organizationId, reference.organizationId))
		.orderBy(asc(user.name));
	return rows.flatMap((row) => {
		const role = resolveOrganizationRole(row.role);
		const found =
			role && resolveProjectRole(role, row.assignedRole)
				? person(row.id, row.name, row.email, row.image)
				: null;
		return found ? [found] : [];
	});
}

export async function getMetricDetail(
	database: Database,
	actor: Actor,
	reference: MetricReference,
	signal?: AbortSignal,
): Promise<MetricDetail> {
	await requireProject(database, actor, reference);
	const [definitions, added, attributes, insights, people] = await Promise.all([
		isCalculatedMetric(reference.metric)
			? resolveCalculation(database, reference, reference.metric).then(
					(definition) =>
						new Map([[reference.metric, calculatedCatalogMetric(definition)]]),
				)
			: withAnalyticsSlot(database, reference.organizationId, signal, () =>
					metricDefinitions(
						getTelemetryClient(),
						reference.projectId,
						[reference.metric],
						signal,
					),
				),
		metricAnnotations(database, reference, reference.metric),
		metricAttributes(database, reference, signal),
		metricInsights(database, reference),
		projectPeople(database, reference),
	]);
	const definition = definitions.get(reference.metric);
	if (!definition) throw new OperationError("NOT_FOUND", "Metric not found");
	return {
		metric: metricEntry(definition, added.get(reference.metric)),
		attributes,
		insights,
		people,
	};
}

export async function getAttributeDetail(
	database: Database,
	actor: Actor,
	reference: AttributeReference,
	signal?: AbortSignal,
): Promise<AttributeDetail> {
	await requireProject(database, actor, reference);
	const [attributes, annotations, metrics] = await Promise.all([
		withAnalyticsSlot(database, reference.organizationId, signal, () =>
			listAttributeCatalog(
				getTelemetryClient(),
				reference.projectId,
				undefined,
				signal,
			),
		),
		attributeAnnotations(database, reference, reference),
		metricEntries(database, reference, signal),
	]);
	const attribute = attributes.find(
		(entry) => entry.scope === reference.scope && entry.key === reference.key,
	);
	if (!attribute) throw new OperationError("NOT_FOUND", "Attribute not found");
	// Values come from a bounded sample of recent points, which keeps the scan within
	// the reader's limits; the page still opens when they are unavailable.
	const values = await withAnalyticsSlot(
		database,
		reference.organizationId,
		signal,
		() =>
			attributeValueSample(
				getTelemetryClient(),
				reference.projectId,
				reference.scope,
				reference.key,
				attribute.metrics,
				signal,
			),
	).catch((error: unknown) => {
		if (signal?.aborted) throw error;
		return null;
	});
	const carrying = new Set(attribute.metrics);
	return {
		attribute: attributeEntry(attribute, annotations),
		values,
		metrics: metrics.filter((metric) => carrying.has(metric.name)),
	};
}

/** Saves what members add to a metric; clearing everything removes the row. */
export async function updateMetric(
	database: Database,
	actor: Actor,
	input: UpdateMetricInput,
) {
	await requireProject(database, actor, input, "write");
	const calculation = isCalculatedMetric(input.metric)
		? await resolveCalculation(database, input, input.metric)
		: null;
	if (calculation && input.defaultBreakdown)
		await withAnalyticsSlot(database, input.organizationId, undefined, () =>
			assertCalculationFields(input, calculation, [
				input.defaultBreakdown as string,
			]),
		);
	if (
		input.ownerId &&
		!(await projectPeople(database, input)).some(
			(entry) => entry.id === input.ownerId,
		)
	)
		throw new OperationError(
			"INVALID_INPUT",
			"The owner cannot open this project",
		);
	const field = input.defaultBreakdown
		? parseAttributeField(input.defaultBreakdown)
		: null;
	// Collected metrics can use core fields; attribute defaults must be carried.
	if (field && !calculation) {
		const attributes = await withAnalyticsSlot(
			database,
			input.organizationId,
			undefined,
			() =>
				listAttributeCatalog(
					getTelemetryClient(),
					input.projectId,
					input.metric,
				),
		);
		if (
			!attributes.some(
				(entry) => entry.scope === field.scope && entry.key === field.key,
			)
		)
			throw new OperationError(
				"INVALID_INPUT",
				"The metric has no such attribute",
			);
	}
	await database.transaction(async (transaction) => {
		await lockCalculatedMetrics(transaction, input, [input.metric]);
		const key = and(
			metricsInProject(input),
			eq(metricAnnotation.metricName, input.metric),
		);
		if (
			!input.description &&
			!input.tags.length &&
			!input.status &&
			!input.ownerId &&
			!input.defaultBreakdown
		) {
			await transaction.delete(metricAnnotation).where(key);
			return;
		}
		const values = {
			description: input.description,
			tags: input.tags,
			status: input.status,
			ownerId: input.ownerId,
			defaultBreakdown: input.defaultBreakdown,
			updatedBy: actor.id,
			updatedAt: new Date(),
		};
		await transaction
			.insert(metricAnnotation)
			.values({
				projectId: input.projectId,
				organizationId: input.organizationId,
				metricName: input.metric,
				...values,
			})
			.onConflictDoUpdate({
				target: [metricAnnotation.projectId, metricAnnotation.metricName],
				set: values,
			});
	});
	return { updated: true };
}

export async function updateAttribute(
	database: Database,
	actor: Actor,
	input: UpdateAttributeInput,
) {
	await requireProject(database, actor, input, "write");
	const key = and(
		attributesInProject(input),
		eq(attributeAnnotation.scope, input.scope),
		eq(attributeAnnotation.attributeKey, input.key),
	);
	if (!input.description && !input.tags.length && !input.status) {
		await database.delete(attributeAnnotation).where(key);
		return { updated: true };
	}
	const values = {
		description: input.description,
		tags: input.tags,
		status: input.status,
		updatedBy: actor.id,
		updatedAt: new Date(),
	};
	await database
		.insert(attributeAnnotation)
		.values({
			projectId: input.projectId,
			organizationId: input.organizationId,
			scope: input.scope,
			attributeKey: input.key,
			...values,
		})
		.onConflictDoUpdate({
			target: [
				attributeAnnotation.projectId,
				attributeAnnotation.scope,
				attributeAnnotation.attributeKey,
			],
			set: values,
		});
	return { updated: true };
}

/** What pickers show of members' additions to metrics: description, status and breakdown. */
export async function metricSummaries(
	database: Database,
	reference: ProjectReference,
) {
	const rows = await database
		.select({
			name: metricAnnotation.metricName,
			note: metricAnnotation.description,
			status: metricAnnotation.status,
			defaultBreakdown: metricAnnotation.defaultBreakdown,
		})
		.from(metricAnnotation)
		.where(metricsInProject(reference));
	return new Map(rows.map(({ name, ...summary }) => [name, summary]));
}

/** What pickers show of members' additions to attributes, keyed by `scope/key`. */
export async function attributeSummaries(
	database: Database,
	reference: ProjectReference,
) {
	const rows = await database
		.select({
			scope: attributeAnnotation.scope,
			key: attributeAnnotation.attributeKey,
			note: attributeAnnotation.description,
			status: attributeAnnotation.status,
		})
		.from(attributeAnnotation)
		.where(attributesInProject(reference));
	return new Map(
		rows.map(({ scope, key, ...summary }) => [`${scope}/${key}`, summary]),
	);
}
