import { m } from "@recount/i18n/messages";
import { Link, useHydrated } from "@tanstack/react-router";
import { ArrowLeftIcon, PanelsTopLeftIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FormFeedback } from "../../components/form-feedback";
import { Button } from "../../components/ui/button";
import { useAppMutation } from "../../components/use-app-mutation";
import { IconEmptyState } from "../../components/workspace";
import { taskQueue } from "../../lib/task-queue";
import { cn } from "../../lib/utils";
import type { ProjectReference } from "../../organizations/contracts";
import {
	applyDashboardFilters,
	changedFilterCount,
	type DashboardFilters,
	decodeDashboardFilters,
	encodeDashboardFilters,
} from "../dashboard-filters";
import {
	type Dashboard,
	type DashboardTile,
	MAX_DASHBOARD_TILES,
} from "../dashboards";
import {
	addDashboardTiles,
	removeDashboardTile,
	saveDashboard,
	updateDashboardLayout,
} from "../dashboards.functions";
import { decodeDraft } from "../insight/draft";
import { InsightsHeader } from "../insights-header";
import { AddTilesDialog } from "./add-tiles-dialog";
import { useDashboardActions } from "./dashboard-actions";
import { DashboardGrid } from "./dashboard-grid";
import { DashboardToolbar } from "./dashboard-toolbar";
import { RefreshControl } from "./refresh-control";
import { UnsavedFilters } from "./unsaved-filters";
import { useLayoutHistory } from "./use-layout-history";
import { useLoadProgress } from "./use-load-progress";

const LIST =
	"/organizations/$organizationId/projects/$projectId/insights/dashboards" as const;
/** Tiles that read at once, as PostHog's dashboards do. */
const TILE_CONCURRENCY = 4;

type Change =
	| { kind: "layout"; tiles: DashboardTile[] }
	| { kind: "remove"; tile: DashboardTile }
	| { kind: "add"; insightIds: string[] }
	| { kind: "filters"; filters: string };

/** The overrides in effect: the URL's, when readable, or else the dashboard's saved ones. */
function activeFilters(url: string | undefined, saved: string) {
	const chosen = url === undefined ? null : decodeDashboardFilters(url);
	const filters = chosen ?? decodeDashboardFilters(saved) ?? {};
	return { filters, text: encodeDashboardFilters(filters) };
}

/**
 * A dashboard of saved insights. Overrides chosen here, such as a time range, apply to
 * every tile and live in the URL until a member saves them as the dashboard's own.
 */
export function DashboardPage({
	userId,
	reference,
	canWrite,
	dashboard,
	urlFilters,
	onFilters: writeFilters,
}: {
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	dashboard: Dashboard & { nodes: { id: string; hostname: string }[] };
	/** The URL's overrides as JSON, or absent for the saved ones. */
	urlFilters: string | undefined;
	onFilters: (filters: string | undefined) => void;
}) {
	const hydrated = useHydrated();
	const [tiles, setTiles] = useState(dashboard.tiles);
	useEffect(() => setTiles(dashboard.tiles), [dashboard.tiles]);
	const [queue] = useState(() => taskQueue(TILE_CONCURRENCY));
	// Relative ranges resolve when the page opens or is refreshed, not on every render.
	const [now, setNow] = useState(() => new Date());
	const [adding, setAdding] = useState(false);
	const actions = useDashboardActions(
		userId,
		reference,
		canWrite,
		dashboard.id,
	);

	const saved = encodeDashboardFilters(
		decodeDashboardFilters(dashboard.filters) ?? {},
	);
	// The URL updates after a navigation, so a second change made before then would
	// build on stale overrides; the page keeps its own copy and follows the URL.
	const [chosen, setChosen] = useState(urlFilters);
	useEffect(() => setChosen(urlFilters), [urlFilters]);
	const onFilters = (next: string | undefined) => {
		setChosen(next);
		writeFilters(next);
	};
	const { filters, text: filtersText } = activeFilters(chosen, saved);
	const refresh = useCallback(() => setNow(new Date()), []);
	const load = useLoadProgress();
	const savedFilters = decodeDashboardFilters(saved) ?? {};
	const unsaved =
		filtersText === saved ? 0 : changedFilterCount(filters, savedFilters);
	const nodeNames = useMemo(
		() => new Map(dashboard.nodes.map((node) => [node.id, node.hostname])),
		[dashboard.nodes],
	);
	// Keyed by the overrides' text, so tiles keep their drafts until they really change.
	const drafts = useMemo(() => {
		const overrides = decodeDashboardFilters(filtersText) ?? {};
		return new Map(
			tiles.map((tile) => [
				tile.id,
				applyDashboardFilters(decodeDraft(tile.insight.draft), overrides),
			]),
		);
	}, [tiles, filtersText]);

	const mutation = useAppMutation<Change, unknown>({
		userId,
		transientNotice: true,
		save: (change, signal) => {
			const target = { ...reference, dashboardId: dashboard.id };
			switch (change.kind) {
				case "layout":
					return updateDashboardLayout({
						data: {
							...target,
							tiles: change.tiles.map(({ id, width, height, column }) => ({
								id,
								width,
								height,
								column,
							})),
						},
						signal,
					});
				case "remove":
					return removeDashboardTile({
						data: { ...target, tileId: change.tile.id },
						signal,
					});
				case "add":
					return addDashboardTiles({
						data: { ...target, insightIds: change.insightIds },
						signal,
					});
				case "filters":
					return saveDashboard({
						data: { ...target, name: dashboard.name, filters: change.filters },
						signal,
					});
			}
		},
	});
	// Set with the optimistic change itself; the mutation reports pending a render later,
	// and a tile picked up in between would be dropped when the grid disables.
	const [applying, setApplying] = useState(false);
	const busy = mutation.disabled || applying;
	const apply = async (change: Change) => {
		setApplying(true);
		try {
			const result = await mutation.submit(change);
			// A refused change shows the dashboard as it is stored.
			if (!result || result.error) {
				setTiles(dashboard.tiles);
				return false;
			}
			return await result.refresh();
		} finally {
			setApplying(false);
		}
	};
	const saveLayout = (next: DashboardTile[]) => {
		setTiles(next);
		void apply({ kind: "layout", tiles: next });
	};
	const history = useLayoutHistory({
		tiles,
		canEdit: canWrite,
		busy,
		apply: saveLayout,
	});
	const changeLayout = (next: DashboardTile[]) => {
		history.record(tiles);
		saveLayout(next);
	};
	const remove = (tile: DashboardTile) => {
		setTiles((current) => current.filter((other) => other.id !== tile.id));
		void apply({ kind: "remove", tile });
	};
	const changeFilters = (next: DashboardFilters) => {
		const text = encodeDashboardFilters(next);
		onFilters(text === saved ? undefined : text);
	};
	const saveFilters = async () => {
		if (await apply({ kind: "filters", filters: filtersText }))
			onFilters(undefined);
	};
	const error = mutation.kind === "success" ? "" : mutation.message;

	const heading = (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<Button asChild variant="ghost" size="icon-sm">
				<Link to={LIST} params={reference} aria-label={m.dashboard_back()}>
					<ArrowLeftIcon aria-hidden="true" />
				</Link>
			</Button>
			<PanelsTopLeftIcon
				aria-hidden="true"
				className="size-5 shrink-0 text-primary"
			/>
			<h1 className="truncate text-xl font-semibold">{dashboard.name}</h1>
			{actions.menu(dashboard)}
		</div>
	);

	return (
		<section className="flex min-w-0 flex-col gap-5">
			<InsightsHeader
				tab="dashboards"
				reference={reference}
				heading={heading}
				description={dashboard.description || m.dashboard_page_description()}
				actions={
					<>
						<RefreshControl
							dashboardId={dashboard.id}
							refreshedAt={now}
							progress={load.progress}
							disabled={!hydrated || !tiles.length}
							onRefresh={refresh}
						/>
						{canWrite && (
							<Button
								disabled={busy || tiles.length >= MAX_DASHBOARD_TILES}
								onClick={() => {
									mutation.clearMessage();
									setAdding(true);
								}}
							>
								<PlusIcon aria-hidden="true" />
								{m.dashboard_add_insights()}
							</Button>
						)}
					</>
				}
			/>
			{/* Sticks below the page title; bleeds into the gutters to hide tiles beneath. */}
			<div className="sticky top-(--sticky-header-height) z-10 -mx-4 -my-2 flex flex-col gap-2 bg-background px-4 py-2 md:-mx-6 md:px-6">
				<div
					className={cn(
						// The outline's room is kept when hidden, so controls do not shift.
						"-m-[7px] self-start rounded-lg border border-dashed border-transparent p-1.5",
						unsaved && "border-amber-400/70",
					)}
				>
					<DashboardToolbar
						userId={userId}
						reference={reference}
						filters={filters}
						disabled={!hydrated}
						onChange={changeFilters}
					/>
				</div>
				{unsaved > 0 && (
					<UnsavedFilters
						count={unsaved}
						current={filters}
						saved={savedFilters}
						canSave={canWrite}
						disabled={!hydrated}
						saving={busy}
						onDiscard={() => onFilters(undefined)}
						onSave={() => void saveFilters()}
					/>
				)}
			</div>
			<FormFeedback
				message={adding ? "" : error || actions.error}
				kind="error"
				reserveLine={false}
			/>
			{tiles.length ? (
				<DashboardGrid
					tiles={tiles}
					userId={userId}
					reference={reference}
					now={now}
					queue={queue}
					nodeNames={nodeNames}
					canWrite={canWrite}
					disabled={busy}
					filters={filters}
					onFetching={load.report}
					draftOf={(tile) =>
						drafts.get(tile.id) ?? decodeDraft(tile.insight.draft)
					}
					onLayout={changeLayout}
					onRemove={remove}
				/>
			) : (
				<IconEmptyState
					icon={<PanelsTopLeftIcon aria-hidden="true" />}
					title={m.dashboard_empty()}
					description={
						canWrite
							? m.dashboard_empty_description()
							: m.dashboard_empty_viewer()
					}
					className="bg-card"
				>
					{canWrite && (
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setAdding(true)}
						>
							<PlusIcon aria-hidden="true" />
							{m.dashboard_add_insights()}
						</Button>
					)}
				</IconEmptyState>
			)}
			<AddTilesDialog
				open={adding}
				userId={userId}
				reference={reference}
				room={MAX_DASHBOARD_TILES - tiles.length}
				pending={mutation.pending}
				error={error}
				onClose={() => setAdding(false)}
				onAdd={async (insightIds) => {
					if (await apply({ kind: "add", insightIds })) setAdding(false);
				}}
			/>
			{actions.dialogs}
		</section>
	);
}
