import { m } from "@recount/i18n/messages";
import { type ColumnDef, tableFeatures } from "@tanstack/react-table";
import { CALCULATION_LABEL } from "../analytics/insight/labels";
import { metricLabel } from "../analytics/metric-names";
import { PlainHeader } from "../components/data-table";
import { type InstantValue, unitText } from "./instant";

export const instantValueFeatures = tableFeatures({});

/** Values that change per render reach the stable column definitions here. */
export interface InstantValueMeta {
	nodeLabel: (node: string) => string;
	format: (entry: InstantValue) => string;
}

type Column = ColumnDef<typeof instantValueFeatures, InstantValue>;

const meta = (table: { options: { meta?: unknown } }) =>
	table.options.meta as InstantValueMeta;

export const instantValueColumns: Column[] = [
	{
		id: "metric",
		header: () => <PlainHeader label={m.execution_timeline_metric()} />,
		// Narrow screens show the machine here instead of in its own column.
		cell: ({ row, table }) => (
			<div className="flex flex-col whitespace-normal">
				<span className="font-medium">
					{metricLabel(row.original.measure.metric, row.original.measure.label)}
				</span>
				<span className="text-xs text-muted-foreground">
					{CALCULATION_LABEL[row.original.measure.calculation]()}
				</span>
				<span className="text-xs whitespace-normal wrap-anywhere text-muted-foreground sm:hidden">
					{meta(table).nodeLabel(row.original.node)}
				</span>
			</div>
		),
	},
	{
		id: "machine",
		meta: { className: "hidden sm:table-cell" },
		header: () => <PlainHeader label={m.execution_timeline_machine()} />,
		cell: ({ row, table }) => (
			<span className="break-all">
				{meta(table).nodeLabel(row.original.node)}
			</span>
		),
	},
	{
		id: "value",
		meta: { className: "text-right" },
		header: () => <PlainHeader label={m.execution_timeline_value()} />,
		cell: ({ row, table }) =>
			row.original.value === null ? (
				<span className="flex flex-col items-end text-right whitespace-normal text-muted-foreground">
					<span className="italic">{m.no_recorded_value()}</span>
					<span className="text-xs">{row.original.gap}</span>
				</span>
			) : (
				<span className="flex flex-col items-end">
					<span className="font-mono tabular-nums">
						{meta(table).format(row.original)}
					</span>
					<span className="text-xs whitespace-normal text-muted-foreground md:hidden">
						{unitText(row.original.measure)}
					</span>
				</span>
			),
	},
	{
		id: "unit",
		meta: { className: "hidden md:table-cell" },
		header: () => <PlainHeader label={m.insight_unit()} />,
		cell: ({ row }) => (
			<span className="text-muted-foreground">
				{unitText(row.original.measure)}
			</span>
		),
	},
];
