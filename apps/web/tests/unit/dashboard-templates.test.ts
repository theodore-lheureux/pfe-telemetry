import { expect, test } from "bun:test";
import { m } from "@recount/i18n/messages";
import {
	availableCalculations,
	builtInCalculations,
	calculatedCatalogMetric,
} from "../../src/analytics/calculated-metrics";
import { calculatedPlan } from "../../src/analytics/calculated-plan";
import {
	MAX_FILTER_VALUES,
	MAX_RANGE_SECONDS,
	type MetricDefinition,
} from "../../src/analytics/contracts";
import {
	decodeDashboardFilters,
	decodeTileOverrides,
	MAX_DASHBOARD_FILTERS_LENGTH,
	tileDraft,
} from "../../src/analytics/dashboard-filters";
import {
	builtInDashboardTemplates,
	dashboardTemplate,
	executionPeriod,
	executionTemplate,
	fillTemplateVariables,
	MAX_EXECUTION_NODES,
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
import { parseQuery } from "../../src/analytics/validation";

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
	for (const values of [
		{ $execution: "not a key" },
		{ $execution: 42 },
		{ $cluster: node },
	])
		expect(() =>
			parseCreateTemplateDashboard({ ...reference, values }),
		).toThrow();
	expect(
		parseCreateTemplateDashboard({ ...reference, values: { $node: node } })
			.values,
	).toEqual({ $node: node });
	expect(
		parseCreateTemplateDashboard({
			...reference,
			templateId: "execution",
			values: { $execution: "slurm:48213", $node: null },
		}).values,
	).toEqual({ $execution: "slurm:48213", $node: null });
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

const executionRaw = [
	metric("process.cpu.time", "counter"),
	metric("recount.process.memory.rss", "gauge"),
	metric("process.disk.io", "counter"),
	metric("recount.node.cpu.time", "counter"),
	metric("recount.node.memory.total", "gauge"),
	metric("recount.node.memory.available", "gauge"),
	metric("system.disk.io", "counter"),
];

test("the Execution template's panels are saved drafts over its processes, their nodes and the cluster", () => {
	const template = executionTemplate();
	expect(template.variables).toEqual([
		{ name: "$execution", field: "execution" },
	]);
	expect(
		builtInDashboardTemplates().find((choice) => choice.id === "execution")
			?.template,
	).toEqual(template);
	const now = new Date("2026-11-15T12:00:00Z");
	const drafts = template.tiles.map((tile) => {
		expect(JSON.parse(parseSavedDraft(tile.insight.draft))).toEqual(
			JSON.parse(tile.insight.draft),
		);
		const query = toQuery(decodeDraft(tile.insight.draft), now, "UTC", "en");
		if (!query) throw new Error("Missing query");
		return { tile, query, overrides: decodeTileOverrides(tile.overrides) };
	});
	const stats = drafts.filter(
		({ tile }) => decodeDraft(tile.insight.draft).display.type === "stat",
	);
	expect(stats).toHaveLength(4);
	for (const { query, overrides } of stats) {
		// Totals cover the whole range, never only its latest bucket.
		expect(query.shape).toBe("table");
		expect(overrides).toEqual({});
	}
	const process = drafts.filter(({ query }) =>
		query.measures.every((measure) =>
			/^(process\.|recount\.process\.)/.test(measure.metric),
		),
	);
	const context = drafts.filter((entry) => !process.includes(entry));
	expect(process).toHaveLength(7);
	expect(context).toHaveLength(5);
	for (const { tile, overrides } of process) {
		expect(overrides.ignoreFilters).toBeUndefined();
		expect(tile.executionNodes).toBeUndefined();
	}
	for (const { tile, query, overrides } of context) {
		expect(overrides).toEqual({ ignoreFilters: ["execution"] });
		expect(tile.executionNodes ?? false).toBe(query.groupBy?.[0] === "node");
	}
	expect(
		context.filter(({ query }) => query.groupBy?.[0] === "node"),
	).toHaveLength(3);
	expect(templateCoverage(template, catalog(executionRaw))).toMatchObject({
		count: 12,
		total: 12,
		recommended: true,
	});
	expect(
		templateCoverage(template, catalog(executionRaw.slice(0, 3))).count,
	).toBe(7);
	expect(String(m.dashboard_template_execution({}, { locale: "fr" }))).toBe(
		"Exécution",
	);
});

test("filling $execution filters the processes, sets its period and names its nodes as context", () => {
	const template = executionTemplate();
	const nodes = ["node-b", "node-a"];
	const execution = {
		nodes,
		firstSeen: new Date("2026-11-03T10:00:15.250Z"),
		lastSeen: new Date("2026-11-03T11:00:30.500Z"),
	};
	const filled = fillTemplateVariables(
		template,
		{ $execution: "slurm:48213" },
		execution,
	);
	expect(filled.variables).toEqual([]);
	const filters = decodeDashboardFilters(filled.filters);
	// Whole minutes around the period, so no rate bucket is cut to a sliver.
	expect(filters).toEqual({
		range: {
			kind: "between",
			from: "2026-11-03T10:00:00.000Z",
			to: "2026-11-03T11:01:00.000Z",
		},
		filters: [{ field: "execution", op: "eq", values: ["slurm:48213"] }],
	});
	if (!filters) throw new Error("Unreadable filters");
	for (const [index, tile] of filled.tiles.entries()) {
		const source = template.tiles[index];
		expect(tile).not.toHaveProperty("executionNodes");
		expect(tile.insight).toEqual(source.insight);
		const shown = tileDraft(
			decodeDraft(tile.insight.draft),
			filters,
			decodeTileOverrides(tile.overrides),
		);
		expect(shown.range).toEqual({
			kind: "between",
			from: new Date("2026-11-03T10:00:00.000Z"),
			to: new Date("2026-11-03T11:01:00.000Z"),
		});
		const fields = shown.filters.map((filter) => filter.field);
		expect(fields.includes("execution")).toBe(
			decodeTileOverrides(source.overrides).ignoreFilters === undefined,
		);
		expect(shown.filters.filter((filter) => filter.field === "node")).toEqual(
			source.executionNodes ? [{ field: "node", op: "in", values: nodes }] : [],
		);
	}
	const many = Array.from({ length: 150 }, () => crypto.randomUUID());
	const capped = fillTemplateVariables(
		template,
		{ $execution: "slurm:48213" },
		{ ...execution, nodes: many },
	);
	const scoped = capped.tiles.find(
		(_, index) => template.tiles[index].executionNodes,
	);
	expect(decodeTileOverrides(scoped?.overrides ?? "{}").filters).toEqual([
		{ field: "node", op: "in", values: many.slice(0, MAX_EXECUTION_NODES) },
	]);
	// Room remains for members' own overrides on the same tile.
	expect(MAX_EXECUTION_NODES).toBeLessThanOrEqual(MAX_FILTER_VALUES);
	expect(scoped?.overrides.length ?? 0).toBeLessThan(
		MAX_DASHBOARD_FILTERS_LENGTH / 2,
	);
	// Without an execution, nothing is narrowed and no period is chosen.
	const empty = fillTemplateVariables(template, {}, execution);
	expect(empty.filters).toBe("{}");
	expect(empty.tiles.map((tile) => tile.overrides)).toEqual(
		template.tiles.map((tile) => tile.overrides),
	);
});

test("an execution's period is in whole minutes and keeps its last 30 days", () => {
	const minute = (iso: string) => new Date(iso);
	expect(
		executionPeriod({
			nodes: [],
			firstSeen: minute("2026-11-03T10:00:15.250Z"),
			lastSeen: minute("2026-11-03T10:00:15.250Z"),
		}),
	).toEqual({
		from: minute("2026-11-03T10:00:00.000Z"),
		to: minute("2026-11-03T10:01:00.000Z"),
		clamped: false,
	});
	const lastSeen = minute("2026-11-03T10:00:30.000Z");
	const exactly = executionPeriod({
		nodes: [],
		firstSeen: new Date(lastSeen.getTime() + 30_000 - MAX_RANGE_SECONDS * 1000),
		lastSeen,
	});
	expect(exactly.clamped).toBe(false);
	const long = executionPeriod({
		nodes: [],
		firstSeen: minute("2026-08-01T00:00:00.000Z"),
		lastSeen,
	});
	expect(long).toEqual({
		from: new Date(
			minute("2026-11-03T10:01:00.000Z").getTime() - MAX_RANGE_SECONDS * 1000,
		),
		to: minute("2026-11-03T10:01:00.000Z"),
		clamped: true,
	});
	// The clamped range is still one the query validator accepts.
	const filled = fillTemplateVariables(
		executionTemplate(),
		{ $execution: "slurm:long" },
		{ nodes: [], firstSeen: minute("2026-08-01T00:00:00.000Z"), lastSeen },
	);
	for (const tile of filled.tiles) {
		const draft = tileDraft(
			decodeDraft(tile.insight.draft),
			decodeDashboardFilters(filled.filters) ?? {},
			decodeTileOverrides(tile.overrides),
		);
		const query = toQuery(draft, lastSeen, "UTC", "en");
		expect(() => parseQuery(query)).not.toThrow();
	}
});

test("Execution totals say they cover the observed period, in English and French", () => {
	expect(
		executionTemplate()
			.tiles.slice(0, 4)
			.map((tile) => tile.insight.description),
	).toEqual([
		m.dashboard_template_execution_cpu_time_description(),
		"",
		m.dashboard_template_execution_disk_read_description(),
		m.dashboard_template_execution_disk_written_description(),
	]);
	for (const locale of ["en", "fr"] as const)
		expect(
			String(
				m.dashboard_template_execution_cpu_time_description({}, { locale }),
			),
		).toContain(locale === "en" ? "observed period" : "période observée");
});
