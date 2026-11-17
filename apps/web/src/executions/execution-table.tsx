import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import { cn } from "cn";
import type { ReactNode } from "react";
import {
	DataTable,
	type DataTableColumnMeta,
	PlainHeader,
} from "../components/data-table";
import { TimeDisplay } from "../components/time-display";
import { Badge } from "../components/ui/badge";
import type { ExecutionNode, ExecutionSummary } from "./contracts";
import { formatDuration } from "./duration";
import { nodeLabel, stateLabel } from "./labels";

const features = tableFeatures({});

interface Meta {
	open: (execution: ExecutionSummary) => ReactNode;
	nodes: Map<string, ExecutionNode>;
}
const meta = (table: { options: { meta?: unknown } }) =>
	table.options.meta as Meta;
const hidden = (className: string): DataTableColumnMeta => ({ className });

// Interactive cell content sits above the row's stretched link.
const ABOVE_LINK = "relative z-10";

function StateBadge({ running }: { running: boolean }) {
	return running ? (
		<Badge
			variant="outline"
			className="border-green-600/60 text-green-700 dark:text-green-400"
		>
			<span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
			{stateLabel("running")}
		</Badge>
	) : (
		<Badge variant="secondary">{stateLabel("completed")}</Badge>
	);
}

function NodesCell({
	execution,
	nodes,
}: {
	execution: ExecutionSummary;
	nodes: Map<string, ExecutionNode>;
}) {
	const more = execution.nodeCount - execution.nodeIds.length;
	return (
		<div className="flex max-w-48 flex-col gap-0.5">
			{execution.nodeIds.map((id) => {
				const label = nodeLabel(nodes.get(id) ?? { id, hostname: null });
				return (
					<span key={id} className="truncate">
						{label}
					</span>
				);
			})}
			{more > 0 && (
				<span className="text-xs text-muted-foreground">
					{m.executions_more_nodes({
						count: new Intl.NumberFormat(getLocale()).format(more),
					})}
				</span>
			)}
		</div>
	);
}

const columns: ColumnDef<typeof features, ExecutionSummary>[] = [
	{
		id: "execution",
		header: () => <PlainHeader label={m.executions_column_execution()} />,
		meta: { className: "max-w-52 whitespace-normal sm:max-w-64" },
		cell: ({ row, table }) => (
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					{meta(table).open(row.original)}
					{row.original.workloadVersion && (
						<Badge variant="outline" className="max-w-40 font-mono">
							<span className="truncate">{row.original.workloadVersion}</span>
						</Badge>
					)}
				</div>
				<code className="truncate text-xs text-muted-foreground">
					{row.original.executionKey}
				</code>
			</div>
		),
	},
	{
		id: "state",
		header: () => <PlainHeader label={m.executions_filter_state()} />,
		cell: ({ row }) => <StateBadge running={row.original.running} />,
	},
	{
		id: "nodes",
		header: () => <PlainHeader label={m.execution_node_count()} />,
		meta: hidden("hidden md:table-cell"),
		cell: ({ row, table }) => (
			<NodesCell execution={row.original} nodes={meta(table).nodes} />
		),
	},
	{
		id: "owner",
		header: () => <PlainHeader label={m.executions_filter_owner()} />,
		meta: hidden("hidden lg:table-cell"),
		cell: ({ row }) =>
			row.original.ownerUids.length ? (
				<span className="font-mono tabular-nums">
					{row.original.ownerUids.join(", ")}
				</span>
			) : (
				<span className="text-muted-foreground">
					{m.executions_owner_unknown()}
				</span>
			),
	},
	{
		id: "firstSeen",
		header: () => <PlainHeader label={m.execution_first_seen()} />,
		meta: hidden("hidden sm:table-cell"),
		cell: ({ row }) => (
			<TimeDisplay
				value={row.original.firstSeen}
				mode="compact"
				className={ABOVE_LINK}
			/>
		),
	},
	{
		id: "lastSeen",
		header: () => <PlainHeader label={m.execution_last_seen()} />,
		meta: hidden("hidden sm:table-cell"),
		cell: ({ row }) => (
			<TimeDisplay
				value={row.original.lastSeen}
				mode="relative"
				className={ABOVE_LINK}
			/>
		),
	},
	{
		id: "duration",
		header: () => <PlainHeader label={m.executions_column_duration()} />,
		meta: hidden("hidden 2xl:table-cell"),
		cell: ({ row }) => (
			<span className="tabular-nums">
				{formatDuration(
					row.original.lastSeen.getTime() - row.original.firstSeen.getTime(),
					getLocale(),
				)}
			</span>
		),
	},
];

/** One page of executions; each row opens its execution. */
export function ExecutionTable({
	executions,
	nodes,
	open,
	busy,
}: {
	executions: ExecutionSummary[];
	nodes: ExecutionNode[];
	open: (execution: ExecutionSummary) => ReactNode;
	/** Dims the rows while results for new filters load. */
	busy: boolean;
}) {
	const table = useTable({
		features,
		data: executions,
		columns,
		meta: {
			open,
			nodes: new Map(nodes.map((node) => [node.id, node])),
		} satisfies Meta,
		getRowId: (row) => row.executionKey,
	});
	return (
		<DataTable
			table={table}
			label={m.executions()}
			className={cn(
				"transition-opacity",
				busy && "opacity-60 motion-reduce:transition-none",
			)}
		/>
	);
}
