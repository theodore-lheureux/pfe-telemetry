import { expect, test } from "bun:test";
import { useTable } from "@tanstack/react-table";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryResult } from "../../src/analytics/contracts";
import { DEFAULT_DISPLAY } from "../../src/analytics/insight/draft";
import { InsightTable } from "../../src/analytics/insight/insight-table";
import {
	type InsightTableRow,
	insightTableFeatures,
	insightTableRows,
	insightTimeseriesColumns,
	insightTotalColumns,
} from "../../src/analytics/insight/insight-table-columns";
import { seriesView } from "../../src/analytics/insight/series-view";

const result: QueryResult = {
	shape: "table",
	from: new Date(0),
	to: new Date(60_000),
	bucketSeconds: null,
	groupBy: [],
	measures: [
		{ name: "A", metric: "custom.metric", unit: "1", calculation: "last" },
	],
	formulas: [],
	series: [
		{ measure: "A", group: [], points: [{ bucketMs: null, value: 80 }] },
	],
	limited: false,
	compared: null,
	coverage: null,
};
const view = seriesView(
	result,
	{ ...DEFAULT_DISPLAY, type: "table" },
	(value) => value ?? "—",
	{},
	"en",
);

test("dashboard tables have no duplicate title, export action or inner card frame", () => {
	const html = renderToStaticMarkup(
		<InsightTable
			embedded
			result={result}
			view={view}
			hydrated
			onHover={() => {}}
		/>,
	);
	expect(html).not.toContain("<h2");
	expect(html).not.toContain("Export CSV");
	expect(html).not.toContain("rounded-md border");
	expect(html).toContain(">Total<");
	expect(html).toContain('aria-label="Results"');
	expect(html).toContain("sticky top-0");
	expect(html).toContain("custom.metric");
	expect(html).toContain(">80</span>");
});

test("Explore keeps the standalone results heading and CSV export", () => {
	const html = renderToStaticMarkup(
		<InsightTable result={result} view={view} hydrated onHover={() => {}} />,
	);
	expect(html).toContain(">Results</h2>");
	expect(html).toContain("Export CSV");
	expect(html).toContain("rounded-md border");
});

function SortedLabels({
	rows,
	columns,
	id,
	desc,
}: {
	rows: InsightTableRow[];
	columns: typeof insightTimeseriesColumns;
	id: string;
	desc: boolean;
}) {
	const table = useTable({
		features: insightTableFeatures,
		columns,
		data: rows,
		initialState: { sorting: [{ id, desc }] },
	});
	return (
		<span>
			{table
				.getRowModel()
				.rows.map((row) => row.original.label)
				.join("|")}
		</span>
	);
}

test("every result column sorts numerically with missing values last in both directions", () => {
	const data: QueryResult = {
		...result,
		groupBy: ["host"],
		measures: [{ ...result.measures[0], unit: "By" }],
		series: [
			{
				measure: "A",
				group: ["large"],
				points: [{ bucketMs: null, value: 2_097_152 }],
			},
			{
				measure: "A",
				group: ["missing"],
				points: [{ bucketMs: null, value: null }],
			},
			{
				measure: "A",
				group: ["small"],
				points: [{ bucketMs: null, value: 900 }],
			},
			{
				measure: "A",
				group: ["middle"],
				points: [{ bucketMs: null, value: 1024 }],
			},
		],
	};
	const rows = insightTableRows(
		seriesView(data, DEFAULT_DISPLAY, (value) => value ?? "—", {}, "en"),
	);
	for (const columns of [insightTotalColumns, insightTimeseriesColumns]) {
		for (const column of columns) {
			if (!column.id || column.id === "series") continue;
			expect(
				renderToStaticMarkup(
					<SortedLabels
						rows={rows}
						columns={columns}
						id={column.id}
						desc={false}
					/>,
				),
			).toBe("<span>small|middle|large|missing</span>");
			expect(
				renderToStaticMarkup(
					<SortedLabels rows={rows} columns={columns} id={column.id} desc />,
				),
			).toBe("<span>large|middle|small|missing</span>");
		}
	}
	expect(
		renderToStaticMarkup(
			<SortedLabels
				rows={rows}
				columns={insightTotalColumns}
				id="series"
				desc={false}
			/>,
		),
	).toBe("<span>large|middle|missing|small</span>");
});

test("numeric table columns share precision and right alignment without changing units", () => {
	const data: QueryResult = {
		...result,
		groupBy: ["host"],
		measures: [{ ...result.measures[0], unit: "By" }],
		series: [
			{
				measure: "A",
				group: ["first"],
				points: [{ bucketMs: null, value: 18.4 * 1024 ** 2 }],
			},
			{
				measure: "A",
				group: ["second"],
				points: [{ bucketMs: null, value: 17 * 1024 ** 2 }],
			},
			{
				measure: "A",
				group: ["missing"],
				points: [{ bucketMs: null, value: null }],
			},
		],
	};
	for (const locale of ["en", "fr"]) {
		const tableView = seriesView(
			data,
			DEFAULT_DISPLAY,
			(value) => value ?? "—",
			{},
			locale,
		);
		const html = renderToStaticMarkup(
			<InsightTable
				embedded
				result={data}
				view={tableView}
				hydrated
				onHover={() => {}}
			/>,
		);
		const decimal = locale === "fr" ? "," : ".";
		expect(html).toContain(`18${decimal}4 MiB`);
		expect(html).toContain(`17${decimal}0 MiB`);
		expect(html).toContain("block text-right font-mono tabular-nums");
		expect(html).toContain(">—</span>");
	}
	const tiny: QueryResult = {
		...data,
		series: [
			{
				measure: "A",
				group: ["first"],
				points: [{ bucketMs: null, value: 0.0015 }],
			},
			{
				measure: "A",
				group: ["second"],
				points: [{ bucketMs: null, value: 1 }],
			},
		],
	};
	const tinyView = seriesView(
		tiny,
		{ ...DEFAULT_DISPLAY, unit: "none" },
		(value) => value ?? "—",
		{},
		"en",
	);
	const html = renderToStaticMarkup(
		<InsightTable
			embedded
			result={tiny}
			view={tinyView}
			hydrated
			onHover={() => {}}
		/>,
	);
	expect(html).toContain(">0.0015</span>");
	expect(html).toContain(">1.0000</span>");
});
