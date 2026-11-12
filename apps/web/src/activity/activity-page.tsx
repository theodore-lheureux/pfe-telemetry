import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useHydrated } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
	DEFAULT_RANGE,
	isDefaultRange,
} from "../components/date-range/date-range";
import { TimeDisplay } from "../components/time-display";
import { Button } from "../components/ui/button";
import type { OperationResult } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import { type ActivityRow, useActivityColumns } from "./activity-columns";
import { ActivityEmpty } from "./activity-empty";
import { ActivityHeader } from "./activity-header";
import { activityAccessDenied, displayedActivity } from "./activity-state";
import { ActivityTable } from "./activity-table";
import {
	attributeFields,
	DEFAULT_COLUMNS,
	type ExplorerColumnSettings,
} from "./columns";
import type {
	LiveSnapshot,
	PacketSummary,
	PointCursor,
	PointPage,
} from "./contracts";
import type { ExplorerSelection } from "./explorer-filters";
import { ExplorerToolbar } from "./explorer-toolbar";
import { ActivityInspector } from "./inspector";
import { LiveToolbar, type PausedBy } from "./live-status";
import { PacketSheet } from "./packet-sheet";
import { useExplorerPoints } from "./use-explorer-points";
import { useLiveActivity } from "./use-live-activity";

const DEFAULT_SELECTION: ExplorerSelection = {
	range: DEFAULT_RANGE,
	filters: [],
};

export function ActivityPage({
	mode,
	userId,
	reference,
	initial,
	columns: initialColumns,
}: {
	mode: "explorer" | "live";
	userId: string;
	reference: ProjectReference;
	initial?: OperationResult<PointPage>;
	columns?: OperationResult<ExplorerColumnSettings>;
}) {
	const hydrated = useHydrated();
	const numbers = useMemo(() => new Intl.NumberFormat(getLocale()), []);
	const [pausedBy, setPausedBy] = useState<PausedBy | null>(null),
		[frozen, setFrozen] = useState<PointPage | LiveSnapshot | null>(null);
	const paused = pausedBy !== null;
	const [expanded, setExpanded] = useState(new Set<string>()),
		[cursors, setCursors] = useState<(PointCursor | undefined)[]>([undefined]),
		[generation, setGeneration] = useState(0),
		[selected, setSelected] = useState<PacketSummary | null>(null),
		[selection, setSelection] = useState(DEFAULT_SELECTION),
		[columnSettings, setColumnSettings] = useState<ExplorerColumnSettings>(
			initialColumns?.data ?? {
				columns: DEFAULT_COLUMNS,
				defaults: DEFAULT_COLUMNS,
				canSetDefault: false,
			},
		);
	const fields = useMemo(
		() => attributeFields(columnSettings.columns),
		[columnSettings.columns],
	);
	const cursor = cursors.at(-1);
	const explorerResult = useExplorerPoints({
		userId,
		reference,
		selection,
		fields,
		cursor,
		generation,
		enabled: mode === "explorer",
		initial: initial?.data ?? undefined,
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
				: (page?.points.map((point) => ({ id: point.sampleId, point })) ?? []),
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
	const columns = useActivityColumns({
		mode,
		columns: columnSettings.columns,
		expanded,
		inspect,
		hydrated,
	});
	// Rows shown before a reload; rows missing from it are highlighted as new.
	const beforeReload = useRef<Set<string> | null>(null);
	// A changed query starts again from its newest page.
	const restart = () => {
		beforeReload.current = null;
		setExpanded(new Set());
		setCursors([undefined]);
	};
	const older = () => {
		if (!page?.nextCursor) return;
		beforeReload.current = null;
		setCursors([...cursors, page.nextCursor]);
		setExpanded(new Set());
	};
	const reload = () => {
		setExpanded(new Set());
		beforeReload.current =
			mode === "explorer" ? new Set(rows.map((row) => row.id)) : null;
		if (mode === "explorer") setCursors([undefined]);
		setGeneration((value) => value + 1);
	};
	const isNew = (id: string) =>
		!explorerResult.isPlaceholderData &&
		beforeReload.current !== null &&
		!beforeReload.current.has(id);
	const refreshing =
		mode === "explorer" && result.isFetching && rows.length > 0;
	const empty = !rows.length && !result.isPending && !result.isError;
	// Packets that arrived while the list was frozen; only the newest 100 are kept.
	const unseen =
		paused && live && liveResult.data
			? liveResult.data.received - live.received
			: 0;
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<ActivityHeader mode={mode} reference={reference} />
			<div className="flex flex-wrap items-center justify-between gap-3">
				{mode === "explorer" ? (
					<ExplorerToolbar
						userId={userId}
						reference={reference}
						hydrated={hydrated}
						fetching={result.isFetching}
						selection={selection}
						columns={columnSettings}
						onSelection={(next) => {
							restart();
							setSelection(
								isDefaultRange(next.range) &&
									!next.metric &&
									!next.filters.length
									? DEFAULT_SELECTION
									: next,
							);
						}}
						onColumns={(saved) => {
							restart();
							setColumnSettings(saved);
						}}
						onReload={reload}
					/>
				) : (
					<LiveToolbar
						live={live}
						pausedBy={pausedBy}
						unseen={unseen}
						hydrated={hydrated}
						onReload={reload}
						onPause={() => pause("user")}
						onResume={resume}
					/>
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
			<ActivityTable
				label={mode === "live" ? m.activity_live() : m.activity_explorer()}
				rows={rows}
				columns={columns}
				hydrated={hydrated}
				expanded={expanded}
				selectedId={selected?.id}
				refreshing={refreshing}
				pending={result.isPending}
				isNew={isNew}
				onInspect={inspect}
				inspector={(row) => (
					<ActivityInspector
						userId={userId}
						reference={reference}
						point={row.point}
						packet={row.packet}
					/>
				)}
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
				empty={
					empty && (
						<ActivityEmpty
							mode={mode}
							filtered={selection !== DEFAULT_SELECTION}
							disabled={!hydrated || result.isFetching}
							onSearchFurther={
								mode === "explorer" && page?.nextCursor ? older : undefined
							}
						/>
					)
				}
			/>
			<footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>
					{m.activity_showing({ count: numbers.format(rows.length) })}
					{live?.limited && ` · ${m.activity_bounded()}`}
					{page?.nextCursor && page.points.length < 100 && (
						<>
							{` · ${m.activity_searched_to()} `}
							<TimeDisplay value={page.searchedTo} mode="full" />
						</>
					)}
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
							onClick={older}
						>
							{m.activity_older()}
						</Button>
					</div>
				)}
			</footer>
			{mode === "live" && (
				<PacketSheet
					userId={userId}
					reference={reference}
					packet={selected}
					onClose={() => {
						setSelected(null);
						if (pausedBy === "inspector") resume();
					}}
				/>
			)}
		</section>
	);
}
