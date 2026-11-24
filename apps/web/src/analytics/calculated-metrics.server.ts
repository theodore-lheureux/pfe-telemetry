import { and, eq, sql } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { calculatedMetric, metricAnnotation, savedInsight } from "../db/schema";
import { getTelemetryClient } from "../executions/telemetry.server";
import { parseUuid } from "../lib/input";
import { InputError } from "../lib/input-error";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import { parseProjectReference } from "../organizations/validation";
import {
	builtInCalculations,
	type CalculatedMetric,
	calculatedReference,
	commonAttributes,
	parseCalculation,
} from "./calculated-metrics";
import { capabilities } from "./capabilities";
import { withAnalyticsSlot } from "./capacity.server";
import { listAttributeCatalog, metricDefinitions } from "./discovery.server";
import { attributeField } from "./fields";
import { parseField } from "./validation";

type Database = ReturnType<typeof getDatabase>;
function scope(reference: ProjectReference) {
	return and(
		eq(calculatedMetric.projectId, reference.projectId),
		eq(calculatedMetric.organizationId, reference.organizationId),
	);
}
export async function calculatedDefinitions(
	database: Database,
	reference: ProjectReference,
): Promise<CalculatedMetric[]> {
	const rows = await database
		.select()
		.from(calculatedMetric)
		.where(scope(reference));
	return [
		...builtInCalculations(),
		...rows.map((row) => ({
			...row.definition,
			id: row.id,
			name: row.name,
			description: row.description,
			builtIn: false,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		})),
	];
}
export async function resolveCalculation(
	database: Database,
	reference: ProjectReference,
	metric: string,
) {
	const found = (await calculatedDefinitions(database, reference)).find(
		(definition) => calculatedReference(definition.id) === metric,
	);
	if (!found)
		throw new OperationError("NOT_FOUND", "Calculated metric not found");
	return found;
}
export async function getCalculation(
	database: Database,
	actor: Actor,
	reference: ProjectReference & { metric: string },
) {
	await requireProject(database, actor, reference);
	return resolveCalculation(database, reference, reference.metric);
}

export async function calculationAttributes(
	reference: ProjectReference,
	definition: CalculatedMetric,
	signal?: AbortSignal,
) {
	const client = getTelemetryClient();
	const names = [...new Set(definition.inputs.map((input) => input.metric))];
	const catalogs = await Promise.all(
		names.map((metric) =>
			listAttributeCatalog(client, reference.projectId, metric, signal),
		),
	);
	const consumed = new Set(
		definition.inputs.flatMap((input) =>
			(input.filters ?? []).map((filter) => filter.field),
		),
	);
	return commonAttributes(catalogs)
		.filter(
			(attribute) =>
				!consumed.has(attributeField(attribute.scope, attribute.key)),
		)
		.map((attribute) => ({
			...attribute,
			metric: calculatedReference(definition.id),
			metrics: names,
		}));
}
export async function assertCalculationFields(
	reference: ProjectReference,
	definition: CalculatedMetric,
	fields: string[],
	signal?: AbortSignal,
) {
	const consumed = new Set(
		definition.inputs.flatMap((input) =>
			(input.filters ?? []).map((filter) => filter.field),
		),
	);
	if (fields.some((field) => consumed.has(field)))
		throw new InputError(
			"INVALID_QUERY",
			"This field is fixed by the calculated metric",
		);
	const attributes = fields.some(
		(field) => parseField(field).type === "attribute",
	)
		? await calculationAttributes(reference, definition, signal)
		: [];
	const allowed = new Set(
		attributes.map((attribute) =>
			attributeField(attribute.scope, attribute.key),
		),
	);
	for (const field of fields) {
		if (parseField(field).type === "attribute" && !allowed.has(field))
			throw new InputError(
				"INVALID_QUERY",
				"This field is not a compatible dimension of the calculated metric",
			);
	}
}
export function parseSaveCalculation(value: unknown) {
	if (!value || typeof value !== "object")
		throw new InputError("INVALID_QUERY", "Invalid calculated metric");
	const input = value as Record<string, unknown>;
	const reference = parseProjectReference(input);
	const id = parseUuid(input.id, "calculated metric identifier");
	if (typeof input.create !== "boolean")
		throw new InputError("INVALID_QUERY", "Invalid save intent");
	if (
		typeof input.name !== "string" ||
		!input.name.trim() ||
		input.name.trim().length > 120 ||
		/\p{Cc}/u.test(input.name)
	)
		throw new InputError("INVALID_QUERY", "Invalid calculated metric name");
	if (typeof input.description !== "string" || input.description.length > 1000)
		throw new InputError("INVALID_QUERY", "Invalid description");
	return {
		...reference,
		id,
		create: input.create,
		name: input.name.trim(),
		description: input.description.trim(),
		definition: parseCalculation(input.definition),
	};
}
function readCalculationInputs(
	projectId: string,
	names: string[],
	signal?: AbortSignal,
) {
	return metricDefinitions(getTelemetryClient(), projectId, names, signal);
}
export async function saveCalculation(
	database: Database,
	actor: Actor,
	input: ReturnType<typeof parseSaveCalculation>,
	signal?: AbortSignal,
	read = readCalculationInputs,
) {
	await requireProject(database, actor, input, "write");
	parseUuid(input.id, "calculated metric identifier");
	input = { ...input, definition: parseCalculation(input.definition) };
	await withAnalyticsSlot(database, input.organizationId, signal, async () => {
		const definitions = await read(
			input.projectId,
			input.definition.inputs.map((measure) => measure.metric),
			signal,
		);
		for (const measure of input.definition.inputs) {
			const definition = definitions.get(measure.metric);
			if (
				!definition ||
				!capabilities(definition).calculations.includes(measure.calculation)
			)
				throw new InputError(
					"INVALID_CALCULATION",
					"Calculation does not apply to a collected metric in this project",
				);
		}
	});
	const values = {
		name: input.name,
		description: input.description,
		definition: input.definition,
	};
	let saved: typeof calculatedMetric.$inferSelect | undefined;
	if (input.create) {
		[saved] = await database
			.insert(calculatedMetric)
			.values({
				...values,
				id: input.id,
				projectId: input.projectId,
				organizationId: input.organizationId,
				createdBy: actor.id,
			})
			.onConflictDoNothing()
			.returning();
		if (!saved) {
			[saved] = await database
				.select()
				.from(calculatedMetric)
				.where(and(scope(input), eq(calculatedMetric.id, input.id)));
			if (
				saved &&
				(saved.name !== input.name ||
					saved.description !== input.description ||
					JSON.stringify(parseCalculation(saved.definition)) !==
						JSON.stringify(input.definition))
			)
				throw new OperationError(
					"CONFLICT",
					"Calculated metric identifier already in use",
				);
		}
	} else {
		[saved] = await database
			.update(calculatedMetric)
			.set({ ...values, updatedAt: new Date() })
			.where(and(scope(input), eq(calculatedMetric.id, input.id)))
			.returning();
	}
	if (!saved)
		throw new OperationError("NOT_FOUND", "Calculated metric not found");
	return {
		...saved.definition,
		id: saved.id,
		name: saved.name,
		description: saved.description,
		builtIn: false,
		createdAt: saved.createdAt,
		updatedAt: saved.updatedAt,
	} satisfies CalculatedMetric;
}

export function parseDeleteCalculation(value: unknown) {
	if (!value || typeof value !== "object")
		throw new InputError("INVALID_QUERY", "Invalid calculated metric");
	const input = value as Record<string, unknown>;
	return {
		...parseProjectReference(input),
		id: parseUuid(input.id, "calculated metric identifier"),
	};
}

export async function deleteCalculation(
	database: Database,
	actor: Actor,
	input: ReturnType<typeof parseDeleteCalculation>,
) {
	await requireProject(database, actor, input, "write");
	parseUuid(input.id, "calculated metric identifier");
	await database.transaction(async (transaction) => {
		const [found] = await transaction
			.select({ id: calculatedMetric.id })
			.from(calculatedMetric)
			.where(and(scope(input), eq(calculatedMetric.id, input.id)))
			.for("update");
		if (!found)
			throw new OperationError("NOT_FOUND", "Calculated metric not found");
		const metric = calculatedReference(found.id);
		const [used] = await transaction
			.select({ id: savedInsight.id })
			.from(savedInsight)
			.where(
				and(
					eq(savedInsight.projectId, input.projectId),
					eq(savedInsight.organizationId, input.organizationId),
					sql`${savedInsight.draft}->'series' @> ${JSON.stringify([{ metric }])}::jsonb`,
				),
			)
			.limit(1);
		if (used)
			throw new OperationError(
				"CONFLICT",
				"Calculated metric is used by saved insights",
			);
		await transaction
			.delete(metricAnnotation)
			.where(
				and(
					eq(metricAnnotation.projectId, input.projectId),
					eq(metricAnnotation.organizationId, input.organizationId),
					eq(metricAnnotation.metricName, metric),
				),
			);
		await transaction
			.delete(calculatedMetric)
			.where(and(scope(input), eq(calculatedMetric.id, input.id)));
	});
	return { deleted: true };
}
