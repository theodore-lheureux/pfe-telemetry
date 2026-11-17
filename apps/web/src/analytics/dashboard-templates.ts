import { m } from "@recount/i18n/messages";
import { serializeRange } from "../components/date-range/date-range";
import type { ProjectReference } from "../organizations/contracts";
import { MAX_RANGE_SECONDS, type MetricDefinition } from "./contracts";
import {
	decodeDashboardFilters,
	decodeTileOverrides,
	encodeDashboardFilters,
	encodeTileOverrides,
} from "./dashboard-filters";
import type {
	Dashboard,
	DashboardReference,
	DashboardTile,
} from "./dashboards";
import { decodeDraft } from "./insight/draft";
import execution from "./templates/execution.json" with { type: "json" };
import nodeHealth from "./templates/node-health.json" with { type: "json" };
import { ALLOWED_CALCULATIONS } from "./validation";

/** Each variable fills one field; filling it adds an `eq` dashboard filter. */
export type TemplateVariable =
	| { name: "$node"; field: "node" }
	| { name: "$execution"; field: "execution" };
/**
 * The most nodes an execution's context tiles name. Within `MAX_FILTER_VALUES`, and low
 * enough that the tile's overrides stay well under `MAX_DASHBOARD_FILTERS_LENGTH` when
 * members add their own.
 */
export const MAX_EXECUTION_NODES = 50;

/** An identity-free snapshot in the ordinary dashboard and saved-insight format. */
export type DashboardTemplate = Pick<
	Dashboard,
	"name" | "description" | "filters"
> & {
	variables?: TemplateVariable[];
	tiles: (Pick<
		DashboardTile,
		"width" | "height" | "column" | "overrides" | "options"
	> & {
		insight: Pick<DashboardTile["insight"], "name" | "description" | "draft">;
		/** Filling `$execution` limits this tile to the nodes the execution ran on. */
		executionNodes?: true;
	})[];
};

export interface TemplateChoice {
	id: string;
	scope: "built-in" | "project";
	template: DashboardTemplate;
}

export type TemplateValues = Partial<
	Record<TemplateVariable["name"], string | null>
>;
export type CreateTemplateDashboardInput = ProjectReference & {
	dashboardId: string;
	templateId: string;
	name?: string;
	description?: string;
	values?: TemplateValues;
};
export type SaveDashboardTemplateInput = DashboardReference & {
	templateId: string;
	name: string;
	description: string;
	parameterizeNode: boolean;
};

export const TEMPLATE_COVERAGE_THRESHOLD = 0.6;

export function dashboardTemplate(
	dashboard: DashboardTemplate,
): DashboardTemplate {
	return {
		name: dashboard.name,
		description: dashboard.description,
		filters: dashboard.filters,
		variables: dashboard.variables?.map((variable) => ({ ...variable })) ?? [],
		tiles: dashboard.tiles.map(
			({
				insight,
				width,
				height,
				column,
				overrides,
				options,
				executionNodes,
			}) => ({
				width,
				height,
				column,
				overrides,
				options: { ...options },
				insight: {
					name: insight.name,
					description: insight.description,
					draft: insight.draft,
				},
				...(executionNodes ? { executionNodes } : {}),
			}),
		),
	};
}

const LABELS: Record<string, () => string> = {
	dashboard_template_node_health: m.dashboard_template_node_health,
	dashboard_template_node_health_description:
		m.dashboard_template_node_health_description,
	dashboard_template_cpu_busy: m.dashboard_template_cpu_busy,
	dashboard_template_memory_used: m.dashboard_template_memory_used,
	dashboard_template_processes: m.dashboard_template_processes,
	dashboard_template_disk_throughput: m.dashboard_template_disk_throughput,
	dashboard_template_network_throughput:
		m.dashboard_template_network_throughput,
	dashboard_template_nodes: m.dashboard_template_nodes,
	dashboard_template_execution: m.dashboard_template_execution,
	dashboard_template_execution_description:
		m.dashboard_template_execution_description,
	dashboard_template_execution_cpu_time:
		m.dashboard_template_execution_cpu_time,
	dashboard_template_execution_peak_memory:
		m.dashboard_template_execution_peak_memory,
	dashboard_template_execution_disk_read:
		m.dashboard_template_execution_disk_read,
	dashboard_template_execution_disk_written:
		m.dashboard_template_execution_disk_written,
	dashboard_template_execution_cpu_time_description:
		m.dashboard_template_execution_cpu_time_description,
	dashboard_template_execution_disk_read_description:
		m.dashboard_template_execution_disk_read_description,
	dashboard_template_execution_disk_written_description:
		m.dashboard_template_execution_disk_written_description,
	dashboard_template_execution_cpu: m.dashboard_template_execution_cpu,
	dashboard_template_execution_memory: m.dashboard_template_execution_memory,
	dashboard_template_execution_disk: m.dashboard_template_execution_disk,
	dashboard_template_execution_node_cpu:
		m.dashboard_template_execution_node_cpu,
	dashboard_template_execution_node_memory:
		m.dashboard_template_execution_node_memory,
	dashboard_template_execution_node_disk:
		m.dashboard_template_execution_node_disk,
	dashboard_template_execution_cluster_cpu:
		m.dashboard_template_execution_cluster_cpu,
	dashboard_template_execution_cluster_memory:
		m.dashboard_template_execution_cluster_memory,
};

/** Only labels are resolved at runtime; queries and layouts live in JSON. */
function builtInTemplate(
	source: typeof nodeHealth | typeof execution,
): DashboardTemplate {
	const label = (key: string) => LABELS[key]?.() ?? key;
	return {
		name: label(source.name),
		description: label(source.description),
		filters: JSON.stringify(source.filters),
		variables: source.variables as TemplateVariable[],
		tiles: source.tiles.map((tile) => ({
			width: tile.width as DashboardTile["width"],
			height: tile.height as DashboardTile["height"],
			column: tile.column,
			options: tile.options,
			overrides: JSON.stringify(tile.overrides),
			insight: {
				name: label(tile.insight.name),
				description: label(tile.insight.description),
				draft: JSON.stringify(tile.insight.draft),
			},
			...("executionNodes" in tile && tile.executionNodes
				? { executionNodes: true as const }
				: {}),
		})),
	};
}

export function nodeHealthTemplate(): DashboardTemplate {
	return builtInTemplate(nodeHealth);
}

export function executionTemplate(): DashboardTemplate {
	return builtInTemplate(execution);
}

export function builtInDashboardTemplates(): TemplateChoice[] {
	return [
		{ id: "node-health", scope: "built-in", template: nodeHealthTemplate() },
		{ id: "execution", scope: "built-in", template: executionTemplate() },
	];
}

/** What filling `$execution` needs beyond its key, read when the execution is resolved. */
export interface ExecutionContext {
	nodes: string[];
	firstSeen: Date;
	lastSeen: Date;
}

export function executionContext(execution: {
	facts: { nodeId: string }[];
	firstSeen: Date;
	lastSeen: Date;
}): ExecutionContext {
	return {
		nodes: [...new Set(execution.facts.map((fact) => fact.nodeId))].sort(),
		firstSeen: execution.firstSeen,
		lastSeen: execution.lastSeen,
	};
}

const MINUTE_MS = 60_000;

/**
 * The execution's period in whole minutes, ending after its last observation. A range
 * ending just after that observation would leave a last bucket of a millisecond, and
 * rates divide each bucket's increase by the time it covers. Longer executions keep their
 * last `MAX_RANGE_SECONDS`, the longest range a query reads.
 */
export function executionPeriod({ firstSeen, lastSeen }: ExecutionContext) {
	const minutes = (time: number) => Math.floor(time / MINUTE_MS) * MINUTE_MS;
	const to = minutes(lastSeen.getTime()) + MINUTE_MS;
	const first = minutes(firstSeen.getTime());
	const earliest = to - MAX_RANGE_SECONDS * 1000;
	return {
		from: new Date(Math.max(first, earliest)),
		to: new Date(to),
		clamped: first < earliest,
	};
}

function executionRange(context: ExecutionContext) {
	const { from, to } = executionPeriod(context);
	return serializeRange({ kind: "between", from, to });
}

/**
 * Creation variables become normal dashboard filters, never query-text interpolation.
 * `$execution` also sets the range to the execution's period and names its nodes on the
 * tiles that show them as context.
 */
export function fillTemplateVariables(
	template: DashboardTemplate,
	values: TemplateValues = {},
	execution?: ExecutionContext,
): DashboardTemplate {
	const filters = decodeDashboardFilters(template.filters) ?? {};
	const predicates = [...(filters.filters ?? [])];
	for (const variable of template.variables ?? []) {
		const value = values[variable.name];
		if (value)
			predicates.push({ field: variable.field, op: "eq", values: [value] });
	}
	const context = values.$execution ? execution : undefined;
	const nodes = context?.nodes.slice(0, MAX_EXECUTION_NODES) ?? [];
	const exported = dashboardTemplate(template);
	return {
		...exported,
		variables: [],
		filters: encodeDashboardFilters({
			...filters,
			...(context ? { range: executionRange(context) } : {}),
			filters: predicates,
		}),
		tiles: exported.tiles.map(({ executionNodes: scoped, ...tile }) => {
			if (!scoped || !nodes.length) return tile;
			const overrides = decodeTileOverrides(tile.overrides);
			return {
				...tile,
				overrides: encodeTileOverrides({
					...overrides,
					filters: [
						...(overrides.filters ?? []),
						{ field: "node", op: "in", values: nodes },
					],
				}),
			};
		}),
	};
}

export function parameterizeTemplateNode(
	template: DashboardTemplate,
): DashboardTemplate {
	const filters = decodeDashboardFilters(template.filters) ?? {};
	return {
		...dashboardTemplate(template),
		variables: [{ name: "$node", field: "node" }],
		filters: encodeDashboardFilters({
			...filters,
			filters: filters.filters?.filter((filter) => filter.field !== "node"),
		}),
	};
}

/** A panel needs every input, with a supported calculation, before it counts. */
export function templateCoverage(
	template: DashboardTemplate,
	metrics: MetricDefinition[],
) {
	const known = new Map<string, MetricDefinition>();
	for (const metric of metrics)
		if (!known.has(metric.name)) known.set(metric.name, metric);
	const available = template.tiles.map((tile) =>
		decodeDraft(tile.insight.draft).series.every((series) => {
			const metric = series.metric ? known.get(series.metric) : undefined;
			return (
				metric !== undefined &&
				metric.status !== "hidden" &&
				ALLOWED_CALCULATIONS[metric.behavior].includes(series.calculation)
			);
		}),
	);
	const count = available.filter(Boolean).length;
	return {
		available,
		count,
		total: available.length,
		recommended:
			available.length > 0 &&
			count / available.length >= TEMPLATE_COVERAGE_THRESHOLD,
	};
}

export function previewDashboard(
	template: DashboardTemplate,
	id = "template-preview",
): Dashboard {
	const epoch = new Date(0);
	return {
		...dashboardTemplate(template),
		id,
		createdAt: epoch,
		updatedAt: epoch,
		createdBy: null,
		tiles: template.tiles.map((tile, index) => ({
			...tile,
			id: `preview-${index}`,
			insight: {
				...tile.insight,
				id: `preview-${index}`,
				createdAt: epoch,
				updatedAt: epoch,
				createdBy: null,
				updatedBy: null,
			},
		})),
	};
}
