import { and, asc, eq } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { collectorNode } from "../db/schema";
import { getTelemetryClient } from "../executions/telemetry.server";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import { withAnalyticsSlot } from "./capacity.server";
import type {
	MetricAttributesInput,
	OverviewSection,
	QueryRange,
	RunQueryInput,
} from "./contracts";
import { listAttributes, listMetrics } from "./discovery.server";
import { buildOverviewSection } from "./overview.server";
import { runQuery } from "./runner.server";

type Database = ReturnType<typeof getDatabase>;
const MAX_NODE_NAMES = 1000;

// Revoked and deleted nodes keep their names so older telemetry stays readable.
function nodeNames(database: Database, input: ProjectReference) {
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
	return withAnalyticsSlot(database, input.organizationId, signal, () =>
		run(input.projectId, input.query, signal),
	);
}

/** The builder's vocabulary: discovered metrics and node display names. */
export async function analyticsCatalog(
	database: Database,
	actor: Actor,
	input: ProjectReference,
	signal?: AbortSignal,
) {
	await requireProject(database, actor, input);
	const [metrics, nodes] = await Promise.all([
		withAnalyticsSlot(database, input.organizationId, signal, () =>
			listMetrics(getTelemetryClient(), input.projectId, signal),
		),
		nodeNames(database, input),
	]);
	return { metrics, nodes };
}

export async function metricAttributes(
	database: Database,
	actor: Actor,
	input: MetricAttributesInput,
	signal?: AbortSignal,
) {
	await requireProject(database, actor, input);
	return withAnalyticsSlot(database, input.organizationId, signal, () =>
		listAttributes(getTelemetryClient(), input.projectId, input.metric, signal),
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
