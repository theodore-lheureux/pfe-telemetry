import { m } from "@recount/i18n/messages";
import { Link, useHydrated } from "@tanstack/react-router";
import { ArrowLeftIcon, PanelsTopLeftIcon, PlusIcon } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { serializeRange } from "../../components/date-range/date-range";
import { FormFeedback } from "../../components/form-feedback";
import { Button } from "../../components/ui/button";
import { useAppMutation } from "../../components/use-app-mutation";
import { IconEmptyState } from "../../components/workspace";
import { taskQueue } from "../../lib/task-queue";
import { cn } from "../../lib/utils";
import type { ProjectReference } from "../../organizations/contracts";
import { saveInsight } from "../analytics.functions";
import { AnalyticsHeader } from "../analytics-header";
import {
	changedFilterCount,
	type DashboardFilters,
	decodeDashboardFilters,
	decodeTileOverrides,
	encodeDashboardFilters,
	encodeTileOverrides,
	hasDashboardFilters,
	type TileOverrides,
	tileDraft,
} from "../dashboard-filters";
import {
	type Dashboard,
	type DashboardSummary,
	type DashboardTile,
	MAX_DASHBOARD_TILES,
	type TileOptions,
} from "../dashboards";
import {
	addDashboardTiles,
	copyDashboardTile,
	duplicateDashboardTile,
	removeDashboardTile,
	saveDashboard,
	updateDashboardLayout,
	updateDashboardTile,
} from "../dashboards.functions";
import {
	type Display,
	decodeDraft,
	draftMetricNames,
	encodeDraft,
} from "../insight/draft";
import { chartPolicy } from "../insight/panels/chart-policy";
import { InsightNameDialog } from "../saved/name-dialog";
import { AddTilesDialog } from "./add-tiles-dialog";
import { useDashboardActions } from "./dashboard-actions";
import { DashboardGrid, type PageTileActions } from "./dashboard-grid";
import { DashboardToolbar } from "./dashboard-toolbar";
import { RefreshControl } from "./refresh-control";
import { TileOverridesDialog } from "./tile-overrides-dialog";
import { UnsavedFilters } from "./unsaved-filters";
import { useLayoutHistory } from "./use-layout-history";
import { useLoadProgress } from "./use-load-progress";

const LIST =
	"/organizations/$organizationId/projects/$projectId/dashboards" as const;
/** Tiles that read at once, as PostHog's dashboards do. */
const TILE_CONCURRENCY = 4;

type Change =
	| { kind: "layout"; tiles: DashboardTile[] }
	| { kind: "remove"; tile: DashboardTile }
	| { kind: "add"; insightIds: string[] }
	| { kind: "filters"; filters: string }
	| {
			kind: "tile";
			tile: DashboardTile;
			overrides?: string;
			options?: TileOptions;
	  }
	| {
			kind: "copy";
			tile: DashboardTile;
			target: DashboardSummary;
			move: boolean;
	  }
	| { kind: "duplicate"; tile: DashboardTile; name: string }
	| { kind: "insight"; tile: DashboardTile; name?: string; draft?: string };

const EMPTY_OVERRIDES: TileOverrides = {};
const DASHBOARD =
	"/organizations/$organizationId/projects/$projectId/dashboards/$dashboardId" as const;

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
	preview,
}: {
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	dashboard: Dashboard & { nodes: { id: string; hostname: string }[] };
	/** The URL's overrides as JSON, or absent for the saved ones. */
	urlFilters: string | undefined;
	onFilters: (filters: string | undefined) => void;
	preview?: {
		unavailable: string[];
		notice: ReactNode;
		actions: ReactNode;
	};
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
	const overrides = useMemo(
		() =>
			new Map(
				tiles.map((tile) => [tile.id, decodeTileOverrides(tile.overrides)]),
			),
		[tiles],
	);
	const overridesOf = (tile: DashboardTile) => overrides.get(tile.id) ?? {};
	// Keyed by the overrides' text, so tiles keep their drafts until they really change.
	const drafts = useMemo(() => {
		const dashboardOverrides = decodeDashboardFilters(filtersText) ?? {};
		return new Map(
			tiles.map((tile) => [
				tile.id,
				tileDraft(
					decodeDraft(tile.insight.draft),
					dashboardOverrides,
					overrides.get(tile.id) ?? {},
				),
			]),
		);
	}, [tiles, filtersText, overrides]);
	/** Whether a tile shows something other than its insight as saved. */
	const overridden = (tile: DashboardTile) => {
		const { ignoreDashboard, ...own } = overridesOf(tile);
		return (
			hasDashboardFilters(own) ||
			(!ignoreDashboard && hasDashboardFilters(filters))
		);
	};

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
				case "tile":
					return updateDashboardTile({
						data: {
							...target,
							tileId: change.tile.id,
							...(change.overrides === undefined
								? {}
								: { overrides: change.overrides }),
							...(change.options === undefined
								? {}
								: { options: change.options }),
						},
						signal,
					});
				case "copy":
					return copyDashboardTile({
						data: {
							...target,
							tileId: change.tile.id,
							targetDashboardId: change.target.id,
							move: change.move,
						},
						signal,
					});
				case "duplicate":
					return duplicateDashboardTile({
						data: { ...target, tileId: change.tile.id, name: change.name },
						signal,
					});
				case "insight":
					return saveInsight({
						data: {
							...reference,
							insightId: change.tile.insight.id,
							name: change.name ?? change.tile.insight.name,
							...(change.draft === undefined ? {} : { draft: change.draft }),
						},
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

	const [renaming, setRenaming] = useState<DashboardTile | null>(null);
	const [overriding, setOverriding] = useState<DashboardTile | null>(null);
	const replaceTile = (
		id: string,
		change: (tile: DashboardTile) => DashboardTile,
	) =>
		setTiles((current) =>
			current.map((tile) => (tile.id === id ? change(tile) : tile)),
		);
	// Display changes save one after another; one made during a save goes next.
	const [savingTile, setSavingTile] = useState<string | null>(null);
	const nextDisplay = useRef(new Map<string, DashboardTile>());
	const saveDisplays = async (tileId: string) => {
		setSavingTile(tileId);
		for (
			let tile = nextDisplay.current.get(tileId);
			tile;
			tile = nextDisplay.current.get(tileId)
		) {
			nextDisplay.current.delete(tileId);
			if (!(await apply({ kind: "insight", tile, draft: tile.insight.draft })))
				break;
		}
		nextDisplay.current.delete(tileId);
		setSavingTile(null);
	};
	const actionsFor = (tile: DashboardTile): PageTileActions => ({
		onRename: () => {
			mutation.clearMessage();
			setRenaming(tile);
		},
		onOverrides: () => {
			mutation.clearMessage();
			setOverriding(tile);
		},
		onDuplicate: () =>
			void apply({
				kind: "duplicate",
				tile,
				name: m.tile_copy_name({ name: tile.insight.name }).slice(0, 120),
			}),
		onDisplay: (display: Display) => {
			const draft = encodeDraft({
				...decodeDraft(tile.insight.draft),
				display,
			});
			const next = { ...tile, insight: { ...tile.insight, draft } };
			replaceTile(tile.id, () => next);
			const idle = !nextDisplay.current.size && savingTile === null;
			nextDisplay.current.set(tile.id, next);
			if (idle) void saveDisplays(tile.id);
		},
		onOptions: (options: TileOptions) => {
			replaceTile(tile.id, (current) => ({ ...current, options }));
			void apply({ kind: "tile", tile, options });
		},
		onCopy: async (target: DashboardSummary, move: boolean) => {
			if (move)
				setTiles((current) => current.filter((other) => other.id !== tile.id));
			const done = await apply({ kind: "copy", tile, target, move });
			if (done)
				toast.success(
					<span>
						{move ? m.tile_moved_to() : m.tile_copied_to()}{" "}
						<Link
							to={DASHBOARD}
							params={{ ...reference, dashboardId: target.id }}
							className="font-medium text-primary hover:underline"
						>
							{target.name}
						</Link>
					</span>,
				);
			return done;
		},
	});

	const heading = (
		<div className="flex min-w-0 flex-auto items-center gap-2">
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
			{!preview && actions.menu(dashboard)}
		</div>
	);

	return (
		<section className="flex min-w-0 flex-col gap-5">
			<AnalyticsHeader
				section={preview ? "overview" : "dashboards"}
				heading={heading}
				description={dashboard.description || m.dashboard_page_description()}
				actions={
					<>
						{preview?.actions}
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
			{preview?.notice}
			{/* Sticks below the page title; bleeds into the gutters to hide tiles beneath. Its
			    own padding replaces the section gap above it. */}
			<div className="sticky top-(--sticky-header-height) z-10 -mx-4 -mt-5 -mb-2 flex flex-col gap-2 bg-background px-4 py-2 md:-mx-6 md:px-6">
				<div
					className={cn(
						// The outline's room is kept when hidden, so controls do not shift.
						"-mx-[7px] self-start rounded-lg border border-dashed border-transparent p-1.5",
						unsaved && "border-amber-400/70",
					)}
				>
					<DashboardToolbar
						metrics={[...drafts.values()].flatMap(draftMetricNames)}
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
					preview={!!preview}
					unavailable={preview?.unavailable}
					userId={userId}
					reference={reference}
					now={now}
					queue={queue}
					nodeNames={nodeNames}
					canWrite={canWrite}
					disabled={busy}
					filters={filters}
					overridesOf={overridesOf}
					dashboardId={dashboard.id}
					savingTile={savingTile}
					overridden={overridden}
					actionsFor={actionsFor}
					onFetching={load.report}
					onZoom={(from, to) =>
						changeFilters({
							...filters,
							range: serializeRange({ kind: "between", from, to }),
						})
					}
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
			<InsightNameDialog
				open={renaming !== null}
				title={m.tile_rename_title()}
				initialName={renaming?.insight.name ?? ""}
				pending={mutation.pending}
				error={renaming ? error : ""}
				onClose={() => setRenaming(null)}
				onSubmit={async (name) => {
					if (!renaming) return;
					replaceTile(renaming.id, (tile) => ({
						...tile,
						insight: { ...tile.insight, name },
					}));
					if (await apply({ kind: "insight", tile: renaming, name }))
						setRenaming(null);
				}}
			/>
			<TileOverridesDialog
				metrics={
					overriding
						? draftMetricNames(
								drafts.get(overriding.id) ??
									decodeDraft(overriding.insight.draft),
							)
						: []
				}
				open={overriding !== null}
				supportsBreakdown={
					!overriding ||
					!chartPolicy(
						(drafts.get(overriding.id) ?? decodeDraft(overriding.insight.draft))
							.display.type,
					).reducesSeries
				}
				name={overriding?.insight.name ?? ""}
				initial={overriding ? overridesOf(overriding) : EMPTY_OVERRIDES}
				userId={userId}
				reference={reference}
				pending={mutation.pending}
				error={overriding ? error : ""}
				onClose={() => setOverriding(null)}
				onSave={async (next: TileOverrides) => {
					if (!overriding) return;
					const text = encodeTileOverrides(next);
					replaceTile(overriding.id, (tile) => ({ ...tile, overrides: text }));
					if (await apply({ kind: "tile", tile: overriding, overrides: text }))
						setOverriding(null);
				}}
			/>
			{actions.dialogs}
		</section>
	);
}
