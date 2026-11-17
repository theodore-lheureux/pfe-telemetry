import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { Link, useHydrated } from "@tanstack/react-router";
import { LineChartIcon, RefreshCwIcon } from "lucide-react";
import {
	type HTMLAttributes,
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { LoadingBar } from "../../components/loading-bar";
import { QueryUnavailable } from "../../components/query-unavailable";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../../components/ui/tooltip";
import { useNearView } from "../../components/use-near-view";
import { IconEmptyState } from "../../components/workspace";
import type { taskQueue } from "../../lib/task-queue";
import { formatCompactTime } from "../../lib/time-display";
import { cn } from "../../lib/utils";
import type { ProjectReference } from "../../organizations/contracts";
import type { QueryResult } from "../contracts";
import type { DashboardFilters, TileOverrides } from "../dashboard-filters";
import type { DashboardTile, TileHeight, TileWidth } from "../dashboards";
import { encodeDraft, formulaNames, type InsightDraft } from "../insight/draft";
import { ChartBody } from "../insight/insight-chart";
import { InsightTable } from "../insight/insight-table";
import { type SeriesView, seriesView } from "../insight/series-view";
import { TileInfo } from "./tile-info";
import { TILE_COLOR_VAR, type TileTools } from "./tile-menu";
import { useTileQuery } from "./use-tile-query";

// Written out in full so Tailwind generates each class.
export const TILE_WIDTH_CLASS: Record<TileWidth, string> = {
	2: "lg:col-span-2",
	3: "lg:col-span-3",
	4: "lg:col-span-4",
	5: "lg:col-span-5",
	6: "lg:col-span-6",
	7: "lg:col-span-7",
	8: "lg:col-span-8",
	9: "lg:col-span-9",
	10: "lg:col-span-10",
	11: "lg:col-span-11",
	12: "lg:col-span-12",
};
export const TILE_HEIGHT_CLASS: Record<TileHeight, string> = {
	0: "row-span-1",
	1: "row-span-2",
	2: "row-span-3",
	3: "row-span-4",
	4: "row-span-5",
	5: "row-span-6",
	6: "row-span-7",
};
export const TILE_COLUMN_CLASS: Record<number, string> = {
	1: "lg:col-start-1",
	2: "lg:col-start-2",
	3: "lg:col-start-3",
	4: "lg:col-start-4",
	5: "lg:col-start-5",
	6: "lg:col-start-6",
	7: "lg:col-start-7",
	8: "lg:col-start-8",
	9: "lg:col-start-9",
	10: "lg:col-start-10",
	11: "lg:col-start-11",
};

/**
 * A saved insight on a dashboard: its name, when its result was computed, and the
 * result itself, which loads, refreshes and fails on its own.
 */
export function DashboardTileCard({
	tile,
	draft,
	userId,
	reference,
	now,
	queue,
	nodeNames,
	filters,
	overrides,
	onFetching,
	onZoom,
	header,
	menu,
	resizer,
	className,
	style,
	preview = false,
	unavailable = false,
}: {
	tile: DashboardTile;
	/** The insight's draft with the dashboard's and the tile's overrides applied. */
	draft: InsightDraft;
	filters: DashboardFilters;
	overrides: TileOverrides;
	/** Told when this tile starts and stops loading. */
	onFetching: (tileId: string, fetching: boolean) => void;
	/** A span dragged across the chart, which narrows the dashboard's range. */
	onZoom: (from: Date, to: Date) => void;
	userId: string;
	reference: ProjectReference;
	now: Date;
	queue: ReturnType<typeof taskQueue>;
	nodeNames: Map<string, string>;
	/** Makes the header the place a member picks the tile up. */
	header?: HTMLAttributes<HTMLElement>;
	menu: (tools: TileTools) => ReactNode;
	/** The corner resize handle, for members who may rearrange the dashboard. */
	resizer?: ReactNode;
	className?: string;
	style?: React.CSSProperties;
	preview?: boolean;
	unavailable?: boolean;
}) {
	const id = useId();
	const element = useRef<HTMLElement>(null);
	// Far off screen, a tile neither queries nor draws its chart; it keeps its place.
	const near = useNearView(element);
	const hydrated = useHydrated();
	// A tile refreshed on its own resolves relative ranges against its own time.
	const [refreshed, setRefreshed] = useState<Date | null>(null);
	const at = refreshed && refreshed > now ? refreshed : now;
	const { query, result } = useTileQuery({
		userId,
		reference,
		draft,
		now: at,
		queue,
		// Waits for the first measurement, so tiles below the fold never start loading.
		active: near === true && !unavailable,
	});
	const fetching = result.isFetching;
	useEffect(() => {
		onFetching(tile.id, fetching);
		return () => onFetching(tile.id, false);
	}, [onFetching, tile.id, fetching]);
	const computedAt =
		result.data && !result.isPlaceholderData
			? new Date(result.dataUpdatedAt)
			: null;
	const view = useMemo(() => {
		if (!result.data) return undefined;
		const groupLabel = (value: string | null) => {
			if (value === null) return "—";
			if (draft.groupBy !== "node") return value;
			return nodeNames.get(value) ?? value;
		};
		return seriesView(
			result.data,
			draft.display,
			groupLabel,
			formulaNames(draft),
			getLocale(),
		);
	}, [result.data, draft, nodeNames]);
	const refresh = () => setRefreshed(new Date());
	const color = tile.options.color;
	const flush = draft.display.type === "stat" || draft.display.type === "table";
	return (
		<article
			ref={element}
			style={{
				...style,
				...(color ? { borderTopColor: TILE_COLOR_VAR[color] } : {}),
			}}
			aria-labelledby={`${id}-title`}
			aria-busy={fetching}
			className={cn(
				"relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card",
				color && "border-t-4",
				className,
			)}
		>
			<LoadingBar active={fetching && !!result.data} />
			<header
				{...header}
				className={cn(
					"group/header flex shrink-0 items-start gap-1 px-3 pt-3 pb-2",
					flush && "border-b",
					header?.className,
				)}
			>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-1">
						{/* The link truncates itself so the heading does not clip its focus outline. */}
						<h3 id={`${id}-title`} className="min-w-0 text-sm font-medium">
							<Link
								to="/organizations/$organizationId/projects/$projectId/explore"
								params={reference}
								search={
									preview
										? { q: encodeDraft(draft) }
										: { insight: tile.insight.id }
								}
								className="block truncate rounded-sm hover:underline"
							>
								{tile.insight.name}
							</Link>
						</h3>
						{!preview && (
							<TileInfo
								tile={tile}
								draft={draft}
								filters={filters}
								overrides={overrides}
								computedAt={computedAt}
								result={result.data}
								userId={userId}
							/>
						)}
					</div>
					{tile.insight.description && !tile.options.hideDescription && (
						<p
							className="truncate text-xs text-muted-foreground"
							title={tile.insight.description}
						>
							{tile.insight.description}
						</p>
					)}
				</div>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							data-export-hidden="true"
							disabled={!hydrated || fetching}
							aria-label={m.dashboard_refresh_tile({ name: tile.insight.name })}
							// Shown on hovering the header, on focus or while reloading; touch screens
							// cannot hover, so it always shows there.
							className={cn(
								"transition-opacity focus-visible:opacity-100 group-hover/header:opacity-100",
								!fetching && "pointer-fine:opacity-0",
							)}
							onClick={refresh}
						>
							<RefreshCwIcon
								aria-hidden="true"
								className={fetching ? "motion-safe:animate-spin" : ""}
							/>
						</Button>
					</TooltipTrigger>
					{/* Worked out on opening, so it reads how long ago it is now. */}
					<TooltipContent>
						{computedAt
							? m.dashboard_tile_computed({
									time: formatCompactTime(computedAt, true),
								})
							: m.insight_updating()}
					</TooltipContent>
				</Tooltip>
				{menu({
					data: result.data,
					view,
					computedAt,
					fetching,
					refresh,
					node: () => element.current,
				})}
			</header>
			<div
				className={cn(
					"flex min-h-0 flex-1 flex-col gap-1 overflow-auto",
					!flush && "px-3 pb-3",
				)}
			>
				<TileBody
					draft={draft}
					ready={query !== null}
					unavailable={unavailable}
					error={result.error}
					data={result.data}
					view={view}
					hydrated={hydrated}
					near={near !== false}
					onZoom={onZoom}
				/>
			</div>
			{resizer}
		</article>
	);
}

function TileBody({
	draft,
	ready,
	error,
	data,
	view,
	hydrated,
	near,
	onZoom,
	unavailable,
}: {
	draft: InsightDraft;
	ready: boolean;
	error: Error | null;
	data: QueryResult | undefined;
	view: SeriesView | undefined;
	hydrated: boolean;
	near: boolean;
	onZoom: (from: Date, to: Date) => void;
	unavailable: boolean;
}) {
	if (unavailable)
		return (
			<IconEmptyState
				icon={<LineChartIcon aria-hidden="true" />}
				title={m.dashboard_template_panel_unavailable()}
				description={m.dashboard_template_panel_unavailable_description()}
				heading="h3"
				className="h-full"
			/>
		);
	if (!ready)
		return (
			<IconEmptyState
				icon={<LineChartIcon aria-hidden="true" />}
				title={m.insight_start()}
				heading="h3"
				className="h-full"
			/>
		);
	if (error)
		return (
			<QueryUnavailable
				title={m.insight_unavailable()}
				error={error}
				heading="h3"
				className="h-full"
			/>
		);
	if (!data || !view) return <Skeleton className="h-full w-full" />;
	// Drawn again on returning near the screen, from the result it kept.
	if (!near) return <div className="h-full w-full" aria-hidden="true" />;
	if (draft.display.type === "table" && !view.empty)
		return (
			<InsightTable
				embedded
				result={data}
				view={view}
				hydrated={hydrated}
				onHover={() => {}}
			/>
		);
	return (
		<div className="min-h-0 flex-1 overflow-auto">
			<ChartBody
				result={data}
				view={view}
				display={draft.display}
				hydrated={hydrated}
				highlight={null}
				onZoom={onZoom}
				height="h-full"
				fill
			/>
		</div>
	);
}
