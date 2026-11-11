import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useHydrated } from "@tanstack/react-router";
import {
	type ColumnDef,
	columnVisibilityFeature,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import {
	CalendarIcon,
	ChevronsUpDownIcon,
	HistoryIcon,
	ListFilterIcon,
	Loader2Icon,
	PauseIcon,
	PlayIcon,
	PlusIcon,
	RadioIcon,
	RefreshCwIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import {
	type CSSProperties,
	Fragment,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { StickyHeader } from "../components/sticky-header";
import { TimeDisplay } from "../components/time-display";
import { Button } from "../components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "../components/ui/sheet";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table";
import { type OperationResult, unwrapOperation } from "../lib/operation-result";
import { cn } from "../lib/utils";
import type { ProjectReference } from "../organizations/contracts";
import { listActivityPoints } from "./activity.functions";
import { activityAccessDenied, displayedActivity } from "./activity-state";
import type {
	LiveSnapshot,
	PacketSummary,
	PointCursor,
	PointPage,
	PointSummary,
} from "./contracts";
import { formatMeasurement } from "./format";
import { ActivityInspector } from "./inspector";
import { NodeLabel } from "./node-label";
import { useLiveActivity } from "./use-live-activity";

const features = tableFeatures({ columnVisibilityFeature });
type ActivityRow = { id: string; point?: PointSummary; packet?: PacketSummary };
type PausedBy = "user" | "inspector" | "hover";

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

export function ActivityPage({
	mode,
	userId,
	reference,
	initial,
}: {
	mode: "explorer" | "live";
	userId: string;
	reference: ProjectReference;
	initial?: OperationResult<PointPage>;
}) {
	const hydrated = useHydrated();
	const [pausedBy, setPausedBy] = useState<PausedBy | null>(null),
		[frozen, setFrozen] = useState<PointPage | LiveSnapshot | null>(null);
	const paused = pausedBy !== null;
	const [expanded, setExpanded] = useState(new Set<string>()),
		[cursors, setCursors] = useState<(PointCursor | undefined)[]>([undefined]),
		[generation, setGeneration] = useState(0),
		[selected, setSelected] = useState<PacketSummary | null>(null);
	const cursor = cursors.at(-1),
		locale = getLocale();
	const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale]);
	const days = useMemo(
		() => new Intl.DateTimeFormat(locale, { dateStyle: "long" }),
		[locale],
	);
	const explorerResult = useQuery<PointPage>({
		queryKey: [
			"activity",
			userId,
			reference.organizationId,
			reference.projectId,
			mode,
			cursor,
			generation,
		],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await listActivityPoints({
					data: { ...reference, cursor },
					signal,
				}),
			),
		initialData:
			!cursor && generation === 0 ? (initial?.data ?? undefined) : undefined,
		enabled: mode === "explorer",
		// Keep the current rows on screen while a reload or another page loads.
		placeholderData: keepPreviousData,
		retry: false,
		staleTime: 1000,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnMount: false,
	});
	const liveResult = useLiveActivity(reference, mode === "live", generation);
	const result = mode === "live" ? liveResult : explorerResult;
	const data = displayedActivity({
		paused,
		frozen,
		data: result.data,
		error: result.error,
	});
	const live = data && "packets" in data ? data : undefined,
		page = data && "points" in data ? data : undefined;
	const rows = useMemo<ActivityRow[]>(
		() =>
			live
				? live.packets.map((packet) => ({ id: packet.id, packet }))
				: page
					? page.points.map((point) => ({ id: point.sampleId, point }))
					: [],
		[live, page],
	);
	const pause = useCallback(
		(by: PausedBy) => {
			// Changing the reason keeps the snapshot that is already on screen.
			if (!paused) setFrozen(result.data ?? null);
			setPausedBy(by);
		},
		[paused, result.data],
	);
	const resume = () => {
		setPausedBy(null);
		setFrozen(null);
	};
	const inspect = useCallback(
		(row: ActivityRow) => {
			// Live packets open in a side panel and freeze the list behind it.
			if (mode === "live") {
				if (!paused || pausedBy === "hover") pause("inspector");
				setSelected(row.packet ?? null);
				return;
			}
			setExpanded((previous) => {
				const next = new Set(previous);
				if (next.has(row.id)) next.delete(row.id);
				else next.add(row.id);
				return next;
			});
		},
		[mode, paused, pausedBy, pause],
	);
	const closeInspector = () => {
		setSelected(null);
		if (pausedBy === "inspector") resume();
	};
	const columns = useMemo<ColumnDef<typeof features, ActivityRow>[]>(
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
	const table = useTable({
		features,
		data: rows,
		columns,
		getRowId: (row) => row.id,
	});
	// Rows shown before a reload; rows missing from it are highlighted as new.
	const beforeReload = useRef<Set<string> | null>(null);
	const reload = () => {
		setExpanded(new Set());
		beforeReload.current =
			mode === "explorer" ? new Set(rows.map((row) => row.id)) : null;
		if (mode === "explorer") setCursors([undefined]);
		setGeneration((value) => value + 1);
	};
	const refreshing =
		mode === "explorer" && result.isFetching && rows.length > 0;
	const empty = !rows.length && !result.isPending && !result.isError;
	const columnCount = table.getVisibleLeafColumns().length;
	// Day separators use the browser's calendar day, so they render after hydration.
	const today = hydrated ? days.format(new Date()) : null;
	const dayOf = (row: ActivityRow) => {
		const value = row.point?.measuredAt ?? row.packet?.receivedAt;
		return today && value ? days.format(value) : null;
	};
	// Packets that arrived while the list was frozen; only the newest 100 are kept.
	const unseen =
		paused && live && liveResult.data
			? liveResult.data.received - live.received
			: 0;
	const status = paused
		? pausedBy === "inspector"
			? m.activity_paused_inspecting()
			: pausedBy === "hover"
				? m.activity_paused_hover()
				: m.activity_paused()
		: live?.status === "connected"
			? m.activity_connected()
			: live?.status === "disconnected"
				? m.activity_disconnected()
				: m.activity_connecting();
	const tab = (active: boolean) =>
		cn(
			"-mb-px inline-flex items-center gap-2 border-b-2 pb-2.5 text-sm transition-colors",
			active
				? "border-primary text-primary"
				: "border-transparent text-muted-foreground hover:text-foreground",
		);
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<StickyHeader>
				<h1 className="flex items-center gap-2 text-xl font-semibold">
					<RadioIcon aria-hidden="true" className="size-5" />
					{m.activity_title()}
				</h1>
			</StickyHeader>
			{/* Only the title stays pinned. The header's bottom padding covers 12px below the
			    title, so the description can move up at most 8px without being hidden. */}
			<div className="-mt-2 flex flex-col gap-5">
				<p className="text-sm text-muted-foreground">
					{mode === "live"
						? m.activity_live_description()
						: m.activity_explorer_description()}
				</p>
				<nav aria-label={m.activity_title()} className="flex gap-6 border-b">
					<Link
						to="/organizations/$organizationId/projects/$projectId/activity"
						params={reference}
						activeOptions={{ exact: true }}
						className={tab(mode === "explorer")}
						aria-current={mode === "explorer" ? "page" : undefined}
					>
						<HistoryIcon aria-hidden="true" className="size-4" />
						{m.activity_explorer()}
					</Link>
					<Link
						to="/organizations/$organizationId/projects/$projectId/activity/live"
						params={reference}
						className={tab(mode === "live")}
						aria-current={mode === "live" ? "page" : undefined}
					>
						<RadioIcon aria-hidden="true" className="size-4" />
						{m.activity_live()}
					</Link>
				</nav>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					{mode === "live" ? (
						<span
							role="status"
							title={m.activity_reporting_note()}
							className="inline-flex h-8 items-center gap-2 rounded-md bg-muted px-3 text-sm"
						>
							<span
								aria-hidden="true"
								className={cn(
									"size-2 rounded-full",
									paused
										? "bg-amber-500"
										: live?.status === "connected"
											? "bg-emerald-500 motion-safe:animate-pulse"
											: "bg-muted-foreground",
								)}
							/>
							{paused || live?.status !== "connected" ? (
								<span>{status}</span>
							) : (
								<span className="sr-only">{status}</span>
							)}
							{live?.status === "connected" && (
								<>
									{paused && <span aria-hidden="true">·</span>}
									<span className="font-medium">
										{m.activity_reporting({
											count: numbers.format(live.reportingNodes),
										})}
									</span>
									<span aria-hidden="true" className="text-muted-foreground">
										·
									</span>
									<span className="text-muted-foreground">
										{m.activity_packets_rate({
											count: numbers.format(live.packetsLastMinute),
										})}
									</span>
								</>
							)}
						</span>
					) : null}
					{mode === "live" && unseen > 0 && (
						<Button variant="secondary" size="sm" onClick={resume}>
							{m.activity_show_new({ count: numbers.format(unseen) })}
						</Button>
					)}
					{mode === "explorer" && (
						<>
							<Button variant="outline" disabled>
								<CalendarIcon aria-hidden="true" />
								{m.activity_last_hour()}
							</Button>
							<Button variant="outline" disabled>
								<ListFilterIcon aria-hidden="true" />
								{m.activity_metric_filter()}
							</Button>
							<Button variant="outline" disabled>
								<PlusIcon aria-hidden="true" />
								{m.activity_attribute_filter()}
							</Button>
						</>
					)}
				</div>
				{mode === "explorer" && (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							disabled={!hydrated || result.isFetching}
							onClick={reload}
						>
							<RefreshCwIcon
								aria-hidden="true"
								className={result.isFetching ? "motion-safe:animate-spin" : ""}
							/>
							{m.activity_reload()}
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline" disabled={!hydrated}>
									<SlidersHorizontalIcon aria-hidden="true" />
									{m.activity_columns()}
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{table
									.getAllLeafColumns()
									.filter((column) => column.getCanHide())
									.map((column) => (
										<DropdownMenuCheckboxItem
											key={column.id}
											checked={column.getIsVisible()}
											disabled={
												column.getIsVisible() &&
												table.getVisibleLeafColumns().length <= 3
											}
											onSelect={(event) => event.preventDefault()}
											onCheckedChange={(checked) =>
												column.toggleVisibility(checked === true)
											}
										>
											{typeof column.columnDef.header === "string"
												? column.columnDef.header
												: column.id}
										</DropdownMenuCheckboxItem>
									))}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				)}
				{mode === "live" && (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							size="icon"
							aria-label={m.activity_reload()}
							title={m.activity_reload()}
							disabled={!hydrated || paused}
							onClick={reload}
						>
							<RefreshCwIcon aria-hidden="true" />
						</Button>
						<Button variant="outline" disabled>
							<ListFilterIcon aria-hidden="true" />
							{m.activity_node_filter()}
						</Button>
						<Button variant="outline" disabled>
							<PlusIcon aria-hidden="true" />
							{m.activity_attribute_filter()}
						</Button>
						<Button
							variant="outline"
							disabled={!hydrated}
							onClick={() => (paused ? resume() : pause("user"))}
						>
							{paused ? (
								<PlayIcon aria-hidden="true" />
							) : (
								<PauseIcon aria-hidden="true" />
							)}
							{paused ? m.activity_resume() : m.activity_pause()}
						</Button>
					</div>
				)}
			</div>
			{result.isError && (!paused || activityAccessDenied(result.error)) && (
				<div
					role="alert"
					className="rounded-md border border-destructive/40 p-4"
				>
					<p className="mb-3 text-sm">{m.activity_unavailable()}</p>
					<Button variant="outline" onClick={reload}>
						{m.activity_retry()}
					</Button>
				</div>
			)}
			<div
				aria-busy={refreshing}
				className="relative overflow-hidden rounded-md border bg-card"
				// Hovering a fast live list holds it still so rows can be read and clicked.
				onPointerEnter={(event) => {
					if (
						mode === "live" &&
						event.pointerType === "mouse" &&
						!paused &&
						rows.length
					)
						pause("hover");
				}}
				onPointerLeave={() => {
					if (pausedBy === "hover") resume();
				}}
				style={
					// Tide derives cell padding from the unit padding; keep rows compact.
					{
						"--control-height": "28px",
						"--unit-padding": "8px",
					} as CSSProperties
				}
			>
				{refreshing && (
					<div
						aria-hidden="true"
						className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-primary/15"
					>
						<div className="h-full w-1/3 animate-[navigation-progress_1.1s_ease-in-out_infinite] bg-primary motion-reduce:w-full motion-reduce:animate-none" />
					</div>
				)}
				<Table
					className="text-[13px] leading-5"
					aria-label={
						mode === "live" ? m.activity_live() : m.activity_explorer()
					}
				>
					<TableHeader>
						{table.getHeaderGroups().map((group) => (
							<TableRow key={group.id} className="hover:bg-transparent">
								{group.headers.map((header) => (
									<TableHead
										key={header.id}
										className={
											header.column.id === "expand"
												? "w-10 pr-1 pl-3"
												: undefined
										}
									>
										<table.FlexRender header={header} />
									</TableHead>
								))}
							</TableRow>
						))}
					</TableHeader>
					<TableBody>
						{table.getRowModel().rows.map((row, index, all) => {
							const day = dayOf(row.original);
							const previous = index ? dayOf(all[index - 1].original) : today;
							return (
								<Fragment key={row.id}>
									{day && day !== previous && (
										<TableRow className="bg-muted/40 hover:bg-muted/40">
											<TableCell
												colSpan={columnCount}
												className="py-1.5 text-center text-xs font-medium text-muted-foreground"
											>
												{day}
											</TableCell>
										</TableRow>
									)}
									<TableRow
										className={cn(
											"h-8 cursor-pointer",
											!explorerResult.isPlaceholderData &&
												beforeReload.current &&
												!beforeReload.current.has(row.id) &&
												"motion-safe:animate-[row-arrival_2s_ease-out]",
											(expanded.has(row.id) || selected?.id === row.id) &&
												"bg-muted/40",
										)}
										style={{ "--control-height": "24px" } as CSSProperties}
										onClick={() => hydrated && inspect(row.original)}
									>
										{row.getVisibleCells().map((cell) => (
											<TableCell
												key={cell.id}
												className={
													cell.column.id === "expand"
														? "py-0.5 pr-1 pl-3"
														: "py-1"
												}
											>
												<table.FlexRender cell={cell} />
											</TableCell>
										))}
									</TableRow>
									{expanded.has(row.id) && (
										<TableRow
											id={`activity-${row.id}`}
											className="hover:bg-transparent"
										>
											<TableCell
												colSpan={columnCount}
												className="whitespace-normal bg-muted/20 p-0"
											>
												<ActivityInspector
													userId={userId}
													reference={reference}
													point={row.original.point}
													packet={row.original.packet}
												/>
											</TableCell>
										</TableRow>
									)}
								</Fragment>
							);
						})}
						{result.isPending && (
							<TableRow className="hover:bg-transparent">
								<TableCell
									colSpan={columnCount}
									className="p-10 text-center text-muted-foreground"
									role="status"
								>
									{m.activity_loading()}
								</TableCell>
							</TableRow>
						)}
						{empty && (
							<TableRow className="hover:bg-transparent">
								<TableCell colSpan={columnCount} className="whitespace-normal">
									{/* Tide sets cell block padding, so spacing lives on this wrapper. */}
									<div className="px-6 py-12 text-center">
										{mode === "live" ? (
											<Loader2Icon
												aria-hidden="true"
												className="mx-auto mb-3 size-7 text-muted-foreground motion-safe:animate-spin"
											/>
										) : (
											<HistoryIcon
												aria-hidden="true"
												className="mx-auto mb-3 size-7 text-muted-foreground"
											/>
										)}
										<p className="text-base font-semibold">
											{mode === "live"
												? `${m.activity_empty_live()}…`
												: m.activity_empty_explorer()}
										</p>
										<p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
											{mode === "live"
												? m.activity_empty_live_note()
												: m.activity_empty_explorer_note()}
										</p>
									</div>
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>
			<footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>
					{m.activity_showing({ count: numbers.format(rows.length) })}
					{live?.limited && ` · ${m.activity_bounded()}`}
				</span>
				{mode === "explorer" && (
					<div className="flex flex-wrap items-center gap-2">
						<span>{m.activity_page({ number: cursors.length })}</span>
						<Button
							variant="outline"
							size="sm"
							disabled={!hydrated || cursors.length === 1 || result.isFetching}
							onClick={reload}
						>
							{m.activity_newest()}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={!hydrated || !page?.nextCursor || result.isFetching}
							onClick={() => {
								if (page?.nextCursor) {
									beforeReload.current = null;
									setCursors([...cursors, page.nextCursor]);
									setExpanded(new Set());
								}
							}}
						>
							{m.activity_older()}
						</Button>
					</div>
				)}
			</footer>
			{mode === "live" && (
				<Sheet
					open={selected !== null}
					onOpenChange={(open) => {
						if (!open) closeInspector();
					}}
				>
					<SheetContent className="w-full gap-0 p-0 data-[side=right]:sm:max-w-2xl">
						<SheetHeader className="border-b p-4 pr-12">
							<SheetTitle className="flex items-center gap-2">
								<RadioIcon aria-hidden="true" className="size-4 text-primary" />
								{m.activity_packet_label()}
							</SheetTitle>
							<SheetDescription className="flex flex-wrap items-center gap-x-4 gap-y-1">
								<NodeLabel node={selected?.nodes[0]} />
								{selected && (
									<>
										<TimeDisplay value={selected.receivedAt} mode="full" />
										<span>
											{m.activity_packet_counts({
												points: numbers.format(selected.points),
												metrics: numbers.format(selected.metrics),
											})}
										</span>
									</>
								)}
							</SheetDescription>
						</SheetHeader>
						<div className="min-h-0 flex-1 overflow-y-auto">
							{selected && (
								<ActivityInspector
									key={selected.id}
									userId={userId}
									reference={reference}
									packet={selected}
								/>
							)}
						</div>
					</SheetContent>
				</Sheet>
			)}
		</section>
	);
}
