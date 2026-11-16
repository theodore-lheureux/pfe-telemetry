import { m } from "@recount/i18n/messages";
import type { ProjectReference } from "../organizations/contracts";
import { calculatedReference } from "./calculated-metrics";
import type { MetricDefinition } from "./contracts";
import type { Dashboard, DashboardTile } from "./dashboards";
import {
	DEFAULT_DRAFT,
	decodeDraft,
	encodeDraft,
	type InsightDraft,
	newSeries,
} from "./insight/draft";
import { ALLOWED_CALCULATIONS } from "./validation";

/** A dashboard without project IDs or authors; its insights keep their saved format. */
export type DashboardTemplate = Pick<
	Dashboard,
	"name" | "description" | "filters"
> & {
	tiles: (Pick<
		DashboardTile,
		"width" | "height" | "column" | "overrides" | "options"
	> & {
		insight: Pick<DashboardTile["insight"], "name" | "description" | "draft">;
	})[];
};

export type CreateTemplateDashboardInput = ProjectReference & {
	dashboardId: string;
	templateId: string;
};

export const TEMPLATE_COVERAGE_THRESHOLD = 0.6;

/** The same projection works for a built-in or a member's customized dashboard. */
export function dashboardTemplate(
	dashboard: DashboardTemplate,
): DashboardTemplate {
	return {
		name: dashboard.name,
		description: dashboard.description,
		filters: dashboard.filters,
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

function calculated(name: string, id: string) {
	return {
		...newSeries(name),
		metric: calculatedReference(id),
		calculation: "last" as const,
		combine: "sum" as const,
	};
}

function processes(name: string) {
	return {
		...newSeries(name),
		metric: "recount.collection.discovered.processes",
		combine: "sum" as const,
	};
}

function panel(
	name: string,
	draft: InsightDraft,
	width: DashboardTile["width"] = 6,
) {
	return {
		width,
		height: 2 as const,
		column: null,
		options: {},
		overrides: "{}",
		insight: { name, description: "", draft: encodeDraft(draft) },
	};
}

function throughput(
	metric: string,
	field: string,
	directions: [string, string],
): InsightDraft {
	return {
		...DEFAULT_DRAFT,
		series: directions.map((direction, index) => ({
			...newSeries(String.fromCharCode(65 + index)),
			metric,
			calculation: "rate",
			combine: "sum",
			filters: [{ field, op: "eq", values: [direction] }],
		})),
		display: { ...DEFAULT_DRAFT.display, legend: "bottom" },
	};
}

export function nodeHealthTemplate(): DashboardTemplate {
	const byNode: InsightDraft = {
		...DEFAULT_DRAFT,
		groupBy: "node",
		other: false,
		display: { ...DEFAULT_DRAFT.display, unit: "percent", yMax: 100 },
	};
	return {
		name: m.dashboard_template_node_health(),
		description: m.dashboard_template_node_health_description(),
		filters: "{}",
		tiles: [
			panel(
				m.dashboard_template_cpu_busy(),
				{
					...byNode,
					series: [calculated("A", "cpu-usage")],
				},
				4,
			),
			panel(
				m.dashboard_template_memory_used(),
				{
					...byNode,
					series: [calculated("A", "memory-usage")],
				},
				4,
			),
			panel(
				m.dashboard_template_processes(),
				{
					...byNode,
					series: [processes("A")],
					display: { ...DEFAULT_DRAFT.display, unit: "none" },
				},
				4,
			),
			panel(
				m.dashboard_template_disk_throughput(),
				throughput("system.disk.io", 'attributes["disk.io.direction"]', [
					"read",
					"write",
				]),
			),
			panel(
				m.dashboard_template_network_throughput(),
				throughput("system.network.io", 'attributes["network.io.direction"]', [
					"receive",
					"transmit",
				]),
			),
			panel(
				m.dashboard_template_nodes(),
				{
					...byNode,
					series: [
						calculated("A", "cpu-usage"),
						calculated("B", "memory-usage"),
						processes("C"),
					],
					display: { ...DEFAULT_DRAFT.display, type: "table" },
				},
				12,
			),
		],
	};
}

/** Resolve labels per request/render, never at module initialization. */
export function builtInDashboardTemplates() {
	return [{ id: "node-health", template: nodeHealthTemplate() }];
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

/** Read-only previews use the ordinary dashboard renderer and query path. */
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
