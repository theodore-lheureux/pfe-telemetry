import { and, eq, inArray } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { calculatedMetric, project } from "../db/schema";
import { parseUuid } from "../lib/input";
import { OperationError } from "../lib/operation-error";
import type { ProjectReference } from "../organizations/contracts";
import {
	builtInCalculations,
	CALCULATED_PREFIX,
	calculatedReference,
	isCalculatedMetric,
} from "./calculated-metrics";
import { draftMetricNames, type InsightDraft } from "./insight/draft";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Hold references until the insight write commits; deletion takes an exclusive row lock. */
export async function lockCalculationReferences(
	transaction: Transaction,
	reference: ProjectReference,
	draft: InsightDraft,
) {
	return lockCalculatedMetrics(transaction, reference, draftMetricNames(draft));
}

export async function lockCalculatedMetrics(
	transaction: Transaction,
	reference: ProjectReference,
	metrics: string[],
) {
	const builtIn = new Set(
		builtInCalculations().map((definition) =>
			calculatedReference(definition.id),
		),
	);
	const references = [
		...new Set(
			metrics.filter(
				(metric) => isCalculatedMetric(metric) && !builtIn.has(metric),
			),
		),
	];
	if (!references.length) return;
	// Match the parent-before-child order used by project deletion.
	const [parent] = await transaction
		.select({ id: project.id })
		.from(project)
		.where(
			and(
				eq(project.id, reference.projectId),
				eq(project.organizationId, reference.organizationId),
			),
		)
		.for("key share");
	if (!parent) throw new OperationError("NOT_FOUND", "Project not found");
	const ids = references.map((metric) =>
		parseUuid(
			metric.slice(CALCULATED_PREFIX.length),
			"calculated metric identifier",
		),
	);
	const rows = await transaction
		.select({ id: calculatedMetric.id })
		.from(calculatedMetric)
		.where(
			and(
				eq(calculatedMetric.projectId, reference.projectId),
				eq(calculatedMetric.organizationId, reference.organizationId),
				inArray(calculatedMetric.id, ids),
			),
		)
		.for("key share");
	const available = new Set(rows.map((row) => calculatedReference(row.id)));
	if (references.some((metric) => !available.has(metric)))
		throw new OperationError(
			"NOT_FOUND",
			"Calculated metric not found in this project",
		);
}
