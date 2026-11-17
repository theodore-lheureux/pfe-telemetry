import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import { DataTable } from "../components/data-table";
import { TimeDisplay } from "../components/time-display";
import type { ProjectReference } from "../organizations/contracts";
import type { ExecutionOverlaps, OverlappingExecution } from "./overlaps";

const features = tableFeatures({});
const reference = (table: { options: { meta?: unknown } }) =>
	table.options.meta as ProjectReference;

const columns: ColumnDef<typeof features, OverlappingExecution>[] = [
	{
		id: "execution",
		meta: { className: "min-w-40 whitespace-normal" },
		header: () => m.execution_field(),
		cell: ({ row, table }) => (
			<div className="flex min-w-0 flex-col gap-0.5">
				<Link
					to="/organizations/$organizationId/projects/$projectId/executions/$executionKey"
					params={{
						...reference(table),
						executionKey: row.original.executionKey,
					}}
					className="font-medium break-words hover:underline"
				>
					{row.original.name}
				</Link>
				<code className="text-xs break-all text-muted-foreground">
					{row.original.executionKey}
				</code>
				{row.original.workloadVersion && (
					<span className="text-xs text-muted-foreground">
						{m.execution_workload_version()}: {row.original.workloadVersion}
					</span>
				)}
			</div>
		),
	},
	{
		id: "nodes",
		meta: { className: "min-w-32 whitespace-normal" },
		header: () => m.execution_overlap_nodes(),
		cell: ({ row }) => {
			const hidden = row.original.nodeCount - row.original.nodes.length;
			return (
				<ul className="flex flex-col gap-0.5 text-sm">
					{row.original.nodes.map((node) => (
						<li key={node.nodeId} className="break-words">
							{node.hostname ?? (
								<code className="text-xs break-all">{node.nodeId}</code>
							)}
						</li>
					))}
					{hidden > 0 && (
						<li className="text-xs text-muted-foreground">
							{m.execution_overlap_more_nodes({ count: hidden })}
						</li>
					)}
				</ul>
			);
		},
	},
	{
		id: "interval",
		header: () => m.execution_overlap_interval(),
		cell: ({ row }) => (
			<span className="flex flex-col gap-0.5 text-sm tabular-nums">
				<TimeDisplay value={row.original.from} mode="compact" />
				<span>
					<span aria-hidden="true">– </span>
					<span className="sr-only">{m.execution_overlap_to()} </span>
					<TimeDisplay value={row.original.to} mode="compact" />
				</span>
			</span>
		),
	},
];

/** The overlapping executions, each linking to its own page. */
export function OverlapTable({
	project,
	overlaps,
}: {
	project: ProjectReference;
	overlaps: ExecutionOverlaps;
}) {
	const table = useTable({
		features,
		data: overlaps.executions,
		columns,
		meta: project,
		getRowId: (row) => row.executionKey,
	});
	return <DataTable table={table} label={m.execution_overlap_table()} />;
}
