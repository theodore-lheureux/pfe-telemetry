import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import {
	type ColumnDef,
	columnVisibilityFeature,
	tableFeatures,
} from "@tanstack/react-table";
import { ChevronsUpDownIcon, RadioIcon } from "lucide-react";
import { useMemo } from "react";
import { TimeDisplay } from "../components/time-display";
import { Button } from "../components/ui/button";
import { columnName } from "./column-names";
import type { ExplorerColumn } from "./columns";
import type { PacketSummary, PointSummary } from "./contracts";
import { formatMeasurement } from "./format";
import { NodeLabel } from "./node-label";

export const activityFeatures = tableFeatures({ columnVisibilityFeature });
const features = activityFeatures;
export type ActivityRow = {
	id: string;
	point?: PointSummary;
	packet?: PacketSummary;
};

const RESOURCE_KINDS: Record<number, () => string> = {
	1: m.activity_kind_host,
	2: m.activity_kind_cpu,
	3: m.activity_kind_gpu,
	4: m.activity_kind_process,
	5: m.activity_kind_vm,
	6: m.activity_kind_container,
	7: m.activity_kind_gateway,
	8: m.activity_kind_sensor,
};

function ResourceLabel({ point }: { point: PointSummary }) {
	const kind = RESOURCE_KINDS[point.resourceKind]?.();
	// A host resource reported by its own node repeats the node column.
	const isNode =
		point.resourceId === point.node?.id ||
		point.resourceId === point.node?.name;
	return (
		<span className="flex min-w-0 items-center gap-2" title={point.resourceId}>
			{kind && (
				<span className="shrink-0 rounded border px-1 text-[11px] leading-4 text-muted-foreground">
					{kind}
				</span>
			)}
			{!isNode && (
				<span className="truncate font-mono">{point.resourceId}</span>
			)}
		</span>
	);
}

/**
 * Table columns: Live's fixed packet columns, or the Explorer's chosen columns in order,
 * each built-in or attribute column keeping its custom header.
 */
export function useActivityColumns({
	mode,
	columns,
	expanded,
	inspect,
	hydrated,
}: {
	mode: "explorer" | "live";
	columns: ExplorerColumn[];
	expanded: Set<string>;
	inspect: (row: ActivityRow) => void;
	hydrated: boolean;
}) {
	const locale = getLocale();
	const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale]);
	const base = useMemo<ColumnDef<typeof features, ActivityRow>[]>(
		() => [
			{
				id: "expand",
				header: () => <span className="sr-only">{m.activity_details()}</span>,
				enableHiding: false,
				cell: ({ row }) => (
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={m.activity_expand({
							name:
								row.original.point?.metricName ?? row.original.packet?.id ?? "",
						})}
						{...(mode === "live"
							? { "aria-haspopup": "dialog" as const }
							: {
									"aria-expanded": expanded.has(row.id),
									"aria-controls": `activity-${row.id}`,
								})}
						disabled={!hydrated}
						onClick={(event) => {
							event.stopPropagation();
							inspect(row.original);
						}}
					>
						<ChevronsUpDownIcon aria-hidden="true" />
					</Button>
				),
			},
			{
				id: "name",
				header: mode === "live" ? m.activity_packet() : m.activity_metric(),
				enableHiding: false,
				cell: ({ row }) =>
					row.original.point ? (
						<span
							className="block max-w-96 truncate font-mono"
							title={row.original.point.metricName}
						>
							{row.original.point.metricName}
						</span>
					) : (
						<span className="inline-flex items-center gap-2">
							<span className="inline-flex items-center gap-1.5 font-medium">
								<RadioIcon
									aria-hidden="true"
									className="size-3.5 text-primary"
								/>
								{m.activity_packet_label()}
							</span>
							<span className="text-muted-foreground">
								{m.activity_packet_counts({
									points: numbers.format(row.original.packet?.points ?? 0),
									metrics: numbers.format(row.original.packet?.metrics ?? 0),
								})}
							</span>
						</span>
					),
			},
			{
				id: "node",
				header: m.activity_node(),
				cell: ({ row }) => (
					<span className="inline-flex items-center gap-2">
						<NodeLabel
							node={row.original.point?.node ?? row.original.packet?.nodes[0]}
						/>
						{(row.original.packet?.nodes.length ?? 0) > 1 && (
							<span className="text-muted-foreground">
								{m.activity_more_nodes({
									count: (row.original.packet?.nodes.length ?? 1) - 1,
								})}
							</span>
						)}
					</span>
				),
			},
			...(mode === "live"
				? [
						{
							id: "source",
							header: m.activity_source(),
							cell: ({ row }: { row: { original: ActivityRow } }) => (
								<span className="font-mono">
									{row.original.packet?.sourceId}
								</span>
							),
						},
						{
							id: "resources",
							header: m.activity_resources(),
							cell: ({ row }: { row: { original: ActivityRow } }) => (
								<span className="tabular-nums">
									{numbers.format(row.original.packet?.resources ?? 0)}
								</span>
							),
						},
						{
							id: "bytes",
							header: m.activity_size(),
							cell: ({ row }: { row: { original: ActivityRow } }) => (
								<span className="tabular-nums">
									{
										formatMeasurement(
											row.original.packet?.bytes ?? 0,
											"By",
											locale,
										).text
									}
								</span>
							),
						},
					]
				: [
						{
							id: "resource",
							header: m.activity_resource(),
							cell: ({ row }: { row: { original: ActivityRow } }) =>
								row.original.point && (
									<span className="block max-w-56">
										<ResourceLabel point={row.original.point} />
									</span>
								),
						},
						{
							id: "value",
							header: m.activity_value(),
							cell: ({ row }: { row: { original: ActivityRow } }) => {
								const point = row.original.point;
								if (point?.value !== null && point?.value !== undefined) {
									const value = formatMeasurement(
										point.value,
										point.unit,
										locale,
									);
									return (
										<span className="tabular-nums" title={value.exact}>
											{value.text}
										</span>
									);
								}
								return point?.count !== null && point?.count !== undefined ? (
									<span className="tabular-nums">
										{m.activity_distribution({
											count: numbers.format(BigInt(point.count)),
										})}
									</span>
								) : (
									<span className="text-muted-foreground">
										{m.activity_no_value()}
									</span>
								);
							},
						},
					]),
			{
				id: "time",
				header: mode === "live" ? m.activity_received() : m.activity_measured(),
				cell: ({ row }) => {
					const point = row.original.point;
					const value = point?.measuredAt ?? row.original.packet?.receivedAt;
					return value ? (
						<TimeDisplay
							value={value}
							mode="relative"
							unixNanoseconds={point?.timeNs}
						/>
					) : (
						"—"
					);
				},
			},
		],
		[mode, expanded, inspect, locale, numbers, hydrated],
	);
	return useMemo<ColumnDef<typeof features, ActivityRow>[]>(() => {
		if (mode === "live") return base;
		const byId = new Map(base.map((column) => [column.id, column]));
		const extra: Partial<
			Record<string, ColumnDef<typeof features, ActivityRow>>
		> = {
			unit: {
				id: "unit",
				cell: ({ row }) => (
					<span className="font-mono">{row.original.point?.unit || "—"}</span>
				),
			},
			scope: {
				id: "scope",
				cell: ({ row }) => (
					<span className="block max-w-64 truncate font-mono">
						{row.original.point?.scopeName || "—"}
						{row.original.point?.scopeVersion && (
							<span className="text-muted-foreground">
								{" "}
								{row.original.point.scopeVersion}
							</span>
						)}
					</span>
				),
			},
			source: {
				id: "source",
				cell: ({ row }) => (
					<span className="block max-w-56 truncate font-mono">
						{row.original.point?.sourceId}
					</span>
				),
			},
		};
		const expand = byId.get("expand");
		return [
			...(expand ? [expand] : []),
			...columns.map((column) => {
				const header = () => column.label ?? columnName(column.field);
				const builtIn =
					column.field === "metric"
						? byId.get("name")
						: (byId.get(column.field) ?? extra[column.field]);
				if (builtIn) return { ...builtIn, id: column.field, header };
				return {
					id: column.field,
					header,
					cell: ({ row }: { row: { original: ActivityRow } }) => {
						const value = row.original.point?.fields[column.field];
						return value === null || value === undefined ? (
							<span className="text-muted-foreground">—</span>
						) : (
							<span className="block max-w-64 truncate font-mono" title={value}>
								{value}
							</span>
						);
					},
				} satisfies ColumnDef<typeof features, ActivityRow>;
			}),
		];
	}, [mode, base, columns]);
}
