import { m } from "@recount/i18n/messages";
import gpu from "../../presets/gpu.json" with { type: "json" };
import nodeHealth from "../../presets/node-health.json" with { type: "json" };
import type { ProjectReference } from "../organizations/contracts";
import { capabilities } from "./capabilities";
import type { MetricDefinition } from "./contracts";
import {
	decodeDashboardFilters,
	encodeDashboardFilters,
} from "./dashboard-filters";
import type {
	Dashboard,
	DashboardReference,
	DashboardTile,
} from "./dashboards";
import { decodeDraft } from "./insight/draft";

export interface TemplateVariable {
	name: "$node";
	field: "node";
}

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
			({ insight, width, height, column, overrides, options }) => ({
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
			}),
		),
	};
}

// Template JSON names its labels by message key; only labels resolve at runtime.
const TEMPLATE_LABELS: Record<string, () => string> = {
	metric_hist_process_cpu: m.metric_hist_process_cpu,
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
	dashboard_template_cpu_nodes: m.dashboard_template_cpu_nodes,
	dashboard_template_gpu: m.dashboard_template_gpu,
	dashboard_template_gpu_description: m.dashboard_template_gpu_description,
	dashboard_template_gpu_utilization: m.dashboard_template_gpu_utilization,
	dashboard_template_gpu_sm_activity: m.dashboard_template_gpu_sm_activity,
	dashboard_template_gpu_sm_occupancy: m.dashboard_template_gpu_sm_occupancy,
	dashboard_template_gpu_pipe_activity: m.dashboard_template_gpu_pipe_activity,
	dashboard_template_gpu_memory_used: m.dashboard_template_gpu_memory_used,
	dashboard_template_gpu_power: m.dashboard_template_gpu_power,
	dashboard_template_gpu_temperature: m.dashboard_template_gpu_temperature,
	dashboard_template_gpu_sm_clock: m.dashboard_template_gpu_sm_clock,
	dashboard_template_gpu_nodes: m.dashboard_template_gpu_nodes,
};

type TemplateJson = typeof nodeHealth;

/** Queries and layouts live in JSON; labels resolve in the current locale. */
function jsonTemplate(json: TemplateJson): DashboardTemplate {
	const label = (key: string) => TEMPLATE_LABELS[key]?.() ?? key;
	return {
		name: label(json.name),
		description: label(json.description),
		filters: JSON.stringify(json.filters),
		variables: json.variables as TemplateVariable[],
		tiles: json.tiles.map((tile) => ({
			...tile,
			width: tile.width as DashboardTile["width"],
			height: tile.height as DashboardTile["height"],
			overrides: JSON.stringify(tile.overrides),
			insight: {
				...tile.insight,
				name: label(tile.insight.name),
				draft: JSON.stringify(tile.insight.draft),
			},
		})),
	};
}

export function nodeHealthTemplate(): DashboardTemplate {
	return jsonTemplate(nodeHealth);
}

export function builtInDashboardTemplates(): TemplateChoice[] {
	return [
		{ id: "node-health", scope: "built-in", template: nodeHealthTemplate() },
		{
			id: "gpu",
			scope: "built-in",
			template: jsonTemplate(gpu as TemplateJson),
		},
	];
}

/** Creation variables become normal dashboard filters, never query-text interpolation. */
export function fillTemplateVariables(
	template: DashboardTemplate,
	values: TemplateValues = {},
): DashboardTemplate {
	const filters = decodeDashboardFilters(template.filters) ?? {};
	const predicates = [...(filters.filters ?? [])];
	for (const variable of template.variables ?? []) {
		const value = values[variable.name];
		if (value)
			predicates.push({ field: variable.field, op: "eq", values: [value] });
	}
	return {
		...dashboardTemplate(template),
		variables: [],
		filters: encodeDashboardFilters({ ...filters, filters: predicates }),
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
				capabilities(metric).calculations.includes(series.calculation)
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
