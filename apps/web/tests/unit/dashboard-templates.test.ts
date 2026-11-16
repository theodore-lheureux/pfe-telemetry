import { expect, test } from "bun:test";
import { m } from "@recount/i18n/messages";
import {
	availableCalculations,
	builtInCalculations,
	calculatedCatalogMetric,
} from "../../src/analytics/calculated-metrics";
import { calculatedPlan } from "../../src/analytics/calculated-plan";
import type { MetricDefinition } from "../../src/analytics/contracts";
import {
	dashboardTemplate,
	fillTemplateVariables,
	nodeHealthTemplate,
	parameterizeTemplateNode,
	previewDashboard,
	templateCoverage,
} from "../../src/analytics/dashboard-templates";
import {
	parseCreateTemplateDashboard,
	parseSaveDashboardTemplate,
} from "../../src/analytics/dashboard-templates-validation";
import { decodeDraft, toQuery } from "../../src/analytics/insight/draft";
import { parseSavedDraft } from "../../src/analytics/saved-insights-validation";

function metric(
	name: string,
	behavior: MetricDefinition["behavior"],
): MetricDefinition {
	return {
		name,
		behavior,
		kind: 1,
		temporality: 0,
		monotonic: null,
		unit: "1",
		description: "",
		firstSeen: new Date(0),
		lastSeen: new Date(0),
	};
}

const raw = [
	metric("recount.node.cpu.time", "counter"),
	metric("recount.node.memory.total", "gauge"),
	metric("recount.node.memory.available", "gauge"),
	metric("recount.collection.discovered.processes", "gauge"),
	metric("system.disk.io", "counter"),
	metric("system.network.io", "counter"),
];
const catalog = (metrics: MetricDefinition[]) => [
	...metrics,
	...availableCalculations(builtInCalculations(), metrics).map(
		calculatedCatalogMetric,
	),
];

test("Node health panels are ordinary saved drafts and expand through the normal query contract", () => {
	const template = nodeHealthTemplate();
	expect(template.tiles).toHaveLength(6);
	const definitions = new Map(
		builtInCalculations().map((definition) => [
			`recount.calculated.${definition.id}`,
			definition,
		]),
	);
	for (const tile of template.tiles) {
		expect(JSON.parse(parseSavedDraft(tile.insight.draft))).toEqual(
			JSON.parse(tile.insight.draft),
		);
		const draft = decodeDraft(tile.insight.draft);
		const query = toQuery(draft, new Date("2026-11-15T12:00:00Z"), "UTC", "en");
		expect(query).not.toBeNull();
		if (!query) throw new Error("Missing query");
		const plan = calculatedPlan(query, definitions);
		expect(
			plan.query.measures.every((measure) =>
				raw.some((source) => source.name === measure.metric),
			),
		).toBe(true);
	}
	const nodes = decodeDraft(template.tiles[5].insight.draft);
	expect(nodes.display.type).toBe("table");
	expect(nodes.groupBy).toBe("node");
	expect(nodes.series).toHaveLength(3);
	for (const tile of template.tiles.slice(3, 5)) {
		const draft = decodeDraft(tile.insight.draft);
		expect(draft.series.every((series) => series.calculation === "rate")).toBe(
			true,
		);
		expect(draft.display.unit).toBe("auto");
	}
	expect(template.variables).toEqual([{ name: "$node", field: "node" }]);
});

test("recommendations count complete panels and require at least 60%, not 60% of metric names", () => {
	const template = nodeHealthTemplate();
	expect(templateCoverage(template, [])).toMatchObject({
		count: 0,
		recommended: false,
	});
	expect(templateCoverage(template, catalog(raw))).toMatchObject({
		count: 6,
		total: 6,
		recommended: true,
	});
	expect(templateCoverage(template, catalog(raw.slice(0, 4)))).toMatchObject({
		count: 4,
		total: 6,
		recommended: true,
		available: [true, true, true, false, false, true],
	});
	const missingMemory = raw.filter(
		(entry) => entry.name !== "recount.node.memory.available",
	);
	expect(templateCoverage(template, catalog(missingMemory)).available).toEqual([
		true,
		false,
		true,
		true,
		true,
		false,
	]);
	const fivePanels = { ...template, tiles: template.tiles.slice(0, 5) };
	expect(templateCoverage(fivePanels, catalog(raw.slice(0, 4)))).toMatchObject({
		count: 3,
		recommended: true,
	});
	expect(templateCoverage(fivePanels, catalog(raw.slice(0, 3)))).toMatchObject({
		count: 2,
		recommended: false,
	});
	expect(
		templateCoverage({ ...template, tiles: [] }, catalog(raw)).recommended,
	).toBe(false);
});

test("incompatible, hidden and older metric variants do not make a panel eligible", () => {
	const template = nodeHealthTemplate();
	const incompatible = [metric("system.disk.io", "gauge"), ...raw];
	expect(templateCoverage(template, catalog(incompatible)).available[3]).toBe(
		false,
	);
	const hidden = raw.map((entry) =>
		entry.name === "system.network.io"
			? { ...entry, status: "hidden" as const }
			: entry,
	);
	expect(templateCoverage(template, catalog(hidden)).available[4]).toBe(false);
});

test("customized dashboards round-trip into a template without IDs or query conversion", () => {
	const dashboard = previewDashboard(nodeHealthTemplate());
	dashboard.name = "Operations";
	dashboard.filters = '{"interval":"5m"}';
	dashboard.tiles[0].width = 12;
	dashboard.tiles[0].overrides = '{"ignoreDashboard":true}';
	const exported = dashboardTemplate(dashboard);
	expect(exported).not.toHaveProperty("id");
	expect(exported.tiles[0].insight).not.toHaveProperty("id");
	expect(exported.tiles[0].insight.draft).toBe(
		dashboard.tiles[0].insight.draft,
	);
	expect(dashboardTemplate(previewDashboard(exported))).toEqual(exported);
});

test("template labels resolve in English and French; creation accepts built-in IDs or project UUIDs", () => {
	expect(String(m.dashboard_template_node_health({}, { locale: "fr" }))).toBe(
		"Santé des nœuds",
	);
	const reference = {
		organizationId: "org",
		projectId: crypto.randomUUID(),
		dashboardId: crypto.randomUUID(),
	};
	expect(
		parseCreateTemplateDashboard({ ...reference, templateId: "node-health" }),
	).toEqual({ ...reference, templateId: "node-health", values: {} });
	const templateId = crypto.randomUUID();
	expect(
		parseCreateTemplateDashboard({ ...reference, templateId }).templateId,
	).toBe(templateId);
	expect(() =>
		parseCreateTemplateDashboard({ ...reference, templateId: "foreign" }),
	).toThrow();
	expect(() =>
		parseCreateTemplateDashboard({
			...reference,
			dashboardId: "invalid",
			templateId: "node-health",
		}),
	).toThrow();
});

test("creation variables are typed values and become ordinary filters without changing insight drafts", () => {
	const template = nodeHealthTemplate();
	const node = crypto.randomUUID();
	const filled = fillTemplateVariables(template, { $node: node });
	expect(JSON.parse(filled.filters)).toEqual({
		filters: [{ field: "node", op: "eq", values: [node] }],
	});
	expect(filled.tiles).toEqual(template.tiles);
	expect(filled.variables).toEqual([]);
	expect(fillTemplateVariables(template, { $node: null }).filters).toBe("{}");
	expect(fillTemplateVariables(template).filters).toBe("{}");
	expect(template.filters).toBe("{}");
	const reference = {
		organizationId: "org",
		projectId: crypto.randomUUID(),
		dashboardId: crypto.randomUUID(),
		templateId: "node-health",
	};
	expect(() =>
		parseCreateTemplateDashboard({
			...reference,
			values: { $node: "injected" },
		}),
	).toThrow();
	expect(() =>
		parseCreateTemplateDashboard({
			...reference,
			values: { $execution: node },
		}),
	).toThrow();
	expect(
		parseCreateTemplateDashboard({ ...reference, values: { $node: node } })
			.values,
	).toEqual({ $node: node });
});

test("a project snapshot can ask for a node while retaining other dashboard and tile settings", () => {
	const source = nodeHealthTemplate();
	source.filters = JSON.stringify({
		interval: "5m",
		filters: [
			{ field: "node", op: "eq", values: [crypto.randomUUID()] },
			{ field: 'attributes["env"]', op: "eq", values: ["host"] },
		],
	});
	source.tiles[0].overrides = '{"ignoreDashboard":true}';
	const parameterized = parameterizeTemplateNode(source);
	expect(JSON.parse(parameterized.filters)).toEqual({
		interval: "5m",
		filters: [{ field: 'attributes["env"]', op: "eq", values: ["host"] }],
	});
	expect(parameterized.variables).toEqual([{ name: "$node", field: "node" }]);
	expect(parameterized.tiles).toEqual(source.tiles);
	const input = {
		organizationId: "org",
		projectId: crypto.randomUUID(),
		dashboardId: crypto.randomUUID(),
		templateId: crypto.randomUUID(),
		name: " Snapshot ",
		description: " Custom ",
		parameterizeNode: true,
	};
	expect(parseSaveDashboardTemplate(input)).toEqual({
		...input,
		name: "Snapshot",
		description: "Custom",
	});
	expect(() =>
		parseSaveDashboardTemplate({ ...input, parameterizeNode: "yes" }),
	).toThrow();
});
