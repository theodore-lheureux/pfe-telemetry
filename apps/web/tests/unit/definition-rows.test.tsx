import { expect, test } from "bun:test";
import { useTable } from "@tanstack/react-table";
import { renderToStaticMarkup } from "react-dom/server";
import { attributeLabel, metricLabel } from "../../src/analytics/metric-names";
import { DataTable } from "../../src/components/data-table";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import {
	type AttributeTableMeta,
	attributeColumns,
	attributeFeatures,
} from "../../src/definitions/attribute-columns";
import type {
	AttributeEntry,
	MetricEntry,
} from "../../src/definitions/contracts";
import {
	type MetricTableMeta,
	metricColumns,
	metricFeatures,
} from "../../src/definitions/metric-columns";

const metrics: MetricEntry[] = ["recount.node.cpu.time", "app.requests"].map(
	(name) => ({
		name,
		kind: 1,
		behavior: "gauge",
		unit: "1",
		collectedDescription: "Collected description",
		description: "",
		tags: [],
		status: null,
		updatedAt: null,
		updatedBy: null,
		owner: null,
		defaultBreakdown: null,
		firstSeen: new Date(0),
		lastSeen: new Date(0),
	}),
);

function MetricRows() {
	const meta: MetricTableMeta = {
		open: (metric) => <span>{metricLabel(metric.name)}</span>,
		expanded: () => false,
		toggle: () => {},
	};
	const table = useTable({
		features: metricFeatures,
		columns: metricColumns,
		data: metrics,
		meta,
		state: { columnVisibility: { status: false } },
	});
	return (
		<TooltipProvider>
			<DataTable table={table} label="Metrics" />
		</TooltipProvider>
	);
}

test("metric rows show friendly names with descriptions without repeating technical identifiers", () => {
	const html = renderToStaticMarkup(<MetricRows />);
	expect(html).toContain(">Node CPU time</span>");
	expect(html).not.toContain(">recount.node.cpu.time<");
	expect(html).toContain(">app.requests</span>");
	expect(html).toContain("Collected description");
	expect(html).not.toContain("<code");
	expect(html).toContain('aria-label="Built-in Recount metric"');
	expect(html).toContain('aria-label="Custom metric"');
});

function AttributeRows() {
	const data: AttributeEntry[] = ["cpu.mode", "app.region"].map((key) => ({
		key,
		scope: "point",
		kind: 2,
		description: "Attribute description",
		tags: [],
		status: null,
		updatedAt: null,
		updatedBy: null,
		lastSeen: new Date(0),
		metrics: [],
	}));
	const meta: AttributeTableMeta = {
		open: (attribute) => <span>{attributeLabel(attribute.key)}</span>,
		metrics: () => null,
	};
	const table = useTable({
		features: attributeFeatures,
		columns: attributeColumns,
		data,
		meta,
		state: { columnVisibility: { status: false } },
	});
	return (
		<TooltipProvider>
			<DataTable table={table} label="Attributes" />
		</TooltipProvider>
	);
}

test("attribute rows use the same source, name and description layout", () => {
	const html = renderToStaticMarkup(<AttributeRows />);
	expect(html).toContain(">CPU mode</span>");
	expect(html).not.toContain(">cpu.mode<");
	expect(html).toContain(">app.region</span>");
	expect(html).toContain("Attribute description");
	expect(html).not.toContain("<code");
	expect(html).toContain('aria-label="Built-in Recount attribute"');
	expect(html).toContain('aria-label="Custom attribute"');
});
