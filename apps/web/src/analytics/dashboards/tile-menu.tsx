import { m } from "@recount/i18n/messages";
import { Link, useHydrated } from "@tanstack/react-router";
import { MoreHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { TimeDisplay } from "../../components/time-display";
import { Button } from "../../components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../../components/ui/tooltip";
import type { ProjectReference } from "../../organizations/contracts";
import type { QueryResult } from "../contracts";
import {
	type DashboardSummary,
	type DashboardTile,
	HEIGHT_PRESETS,
	TILE_COLORS,
	type TileColor,
	type TileHeight,
	type TileOptions,
	type TileWidth,
	WIDTH_PRESETS,
} from "../dashboards";
import { DisplayOptions, spreadUnavailable } from "../insight/display-options";
import {
	type Display,
	decodeDraft,
	encodeDraft,
	type InsightDraft,
} from "../insight/draft";
import type { SeriesView } from "../insight/series-view";
import { DashboardPicker } from "./dashboard-picker";
import { download, fileName, resultCsv, tilePng } from "./tile-export";
import { fittedColumn, type TileSize } from "./tile-resize";

const WIDTH_LABEL: Record<(typeof WIDTH_PRESETS)[number], () => string> = {
	2: m.dashboard_width_sixth,
	4: m.dashboard_width_third,
	6: m.dashboard_width_half,
	8: m.dashboard_width_two_thirds,
	12: m.dashboard_width_full,
};
const HEIGHT_LABEL: Record<(typeof HEIGHT_PRESETS)[number], () => string> = {
	0: m.dashboard_height_compact,
	1: m.dashboard_height_small,
	2: m.dashboard_height_medium,
	3: m.dashboard_height_large,
};
export const COLOR_LABEL: Record<TileColor, () => string> = {
	blue: m.tile_color_blue,
	green: m.tile_color_green,
	orange: m.tile_color_orange,
	purple: m.tile_color_purple,
	red: m.tile_color_red,
};
/** Each color is a slot of the chart palette, so it reads well in both themes. */
export const TILE_COLOR_VAR: Record<TileColor, string> = {
	blue: "var(--viz-1)",
	orange: "var(--viz-2)",
	green: "var(--viz-3)",
	purple: "var(--viz-7)",
	red: "var(--viz-8)",
};
const NO_COLOR = "-";

/** What a tile's menu reads from the tile's own state. */
export interface TileTools {
	data: QueryResult | undefined;
	view: SeriesView | undefined;
	computedAt: Date | null;
	fetching: boolean;
	refresh: () => void;
	/** The tile's element, drawn for PNG exports. */
	node: () => HTMLElement | null;
}

export interface TileActions {
	onMove: (offset: number) => void;
	onResize: (size: Partial<TileSize>) => void;
	onRemove: () => void;
	onRename: () => void;
	onOverrides: () => void;
	onDuplicate: () => void;
	onDisplay: (display: Display) => void;
	onOptions: (options: TileOptions) => void;
	onCopy: (target: DashboardSummary, move: boolean) => Promise<boolean>;
}

/**
 * A tile's actions: open or edit its insight, rename, override, duplicate, change how
 * it shows, size, move or copy it between dashboards, export it, and refresh it.
 */
export function TileMenu({
	tile,
	tools,
	userId,
	reference,
	dashboardId,
	canWrite,
	disabled,
	overridden,
	shownDraft,
	first,
	last,
	savingDisplay,
	actions,
}: {
	tile: DashboardTile;
	tools: TileTools;
	userId: string;
	reference: ProjectReference;
	dashboardId: string;
	canWrite: boolean;
	disabled: boolean;
	/** Whether the dashboard's or the tile's overrides change what the tile shows. */
	overridden: boolean;
	/** The draft as the tile shows it, overrides applied. */
	shownDraft: InsightDraft;
	first: boolean;
	last: boolean;
	savingDisplay: boolean;
	actions: TileActions;
}) {
	const [open, setOpen] = useState(false);
	const hydrated = useHydrated();
	const name = tile.insight.name;
	const explore =
		"/organizations/$organizationId/projects/$projectId/explore" as const;
	const draft = decodeDraft(tile.insight.draft);
	const display = draft.display;
	const exported = async (task: () => Promise<void>, done?: string) => {
		try {
			await task();
			if (done) toast.success(done);
		} catch {
			toast.error(m.tile_export_failed());
		}
	};
	const csv = () =>
		tools.data && tools.view ? resultCsv(tools.data, tools.view) : null;
	const png = async () => {
		const node = tools.node();
		if (!node) throw new Error("The tile is not shown");
		return tilePng(node);
	};
	const copyTo = async (target: DashboardSummary, move: boolean) => {
		setOpen(false);
		await actions.onCopy(target, move);
	};
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					data-export-hidden="true"
					// The menu cannot open before the page is interactive.
					disabled={!hydrated}
					aria-label={m.dashboard_tile_actions({ name })}
				>
					<MoreHorizontalIcon aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				<DropdownMenuItem asChild>
					<Link
						to={explore}
						params={reference}
						search={{ insight: tile.insight.id, q: encodeDraft(shownDraft) }}
					>
						{m.tile_view()}
					</Link>
				</DropdownMenuItem>
				{canWrite && (
					<>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuItem asChild>
									<Link
										to={explore}
										params={reference}
										search={{ insight: tile.insight.id }}
									>
										{overridden && (
											<TriangleAlertIcon
												aria-hidden="true"
												className="text-amber-500"
											/>
										)}
										{m.tile_edit()}
									</Link>
								</DropdownMenuItem>
							</TooltipTrigger>
							{overridden && (
								<TooltipContent side="left" className="max-w-64">
									{m.tile_edit_warning()}
								</TooltipContent>
							)}
						</Tooltip>
						<DropdownMenuItem disabled={disabled} onSelect={actions.onRename}>
							{m.tile_rename()}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={disabled}
							onSelect={actions.onOverrides}
						>
							{m.tile_set_overrides()}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={disabled}
							onSelect={actions.onDuplicate}
						>
							{m.tile_duplicate()}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								{m.display_options()}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="p-3">
								<DisplayOptions
									display={display}
									disabled={disabled && !savingDisplay}
									saving={savingDisplay}
									spreadBlocked={spreadUnavailable(draft)}
									onChange={actions.onDisplay}
								/>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							disabled={disabled}
							onSelect={() =>
								actions.onOptions({
									...tile.options,
									hideDescription: !tile.options.hideDescription,
								})
							}
						>
							{tile.options.hideDescription
								? m.tile_show_description()
								: m.tile_hide_description()}
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger disabled={disabled}>
								{m.tile_set_color()}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								<DropdownMenuRadioGroup
									value={tile.options.color ?? NO_COLOR}
									onValueChange={(value) => {
										const { color: _, ...rest } = tile.options;
										actions.onOptions(
											value === NO_COLOR
												? rest
												: { ...rest, color: value as TileColor },
										);
									}}
								>
									<DropdownMenuRadioItem value={NO_COLOR}>
										{m.tile_color_none()}
									</DropdownMenuRadioItem>
									{TILE_COLORS.map((color) => (
										<DropdownMenuRadioItem key={color} value={color}>
											<span
												aria-hidden="true"
												className="size-3 rounded-full"
												style={{ background: TILE_COLOR_VAR[color] }}
											/>
											{COLOR_LABEL[color]()}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-xs text-muted-foreground uppercase">
							{m.tile_dashboard()}
						</DropdownMenuLabel>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger disabled={disabled}>
								{m.tile_size()}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								<DropdownMenuLabel className="text-xs text-muted-foreground">
									{m.dashboard_width()}
								</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									value={String(tile.width)}
									onValueChange={(value) => {
										const width = Number(value) as TileWidth;
										actions.onResize({
											width,
											column: fittedColumn(width, tile.column),
										});
									}}
								>
									{WIDTH_PRESETS.map((width) => (
										<DropdownMenuRadioItem key={width} value={String(width)}>
											{WIDTH_LABEL[width]()}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
								<DropdownMenuSeparator />
								<DropdownMenuLabel className="text-xs text-muted-foreground">
									{m.dashboard_height()}
								</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									value={String(tile.height)}
									onValueChange={(value) =>
										actions.onResize({ height: Number(value) as TileHeight })
									}
								>
									{HEIGHT_PRESETS.map((height) => (
										<DropdownMenuRadioItem key={height} value={String(height)}>
											{HEIGHT_LABEL[height]()}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuItem
							disabled={disabled || first}
							onSelect={() => actions.onMove(-1)}
						>
							{m.dashboard_move_earlier()}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={disabled || last}
							onSelect={() => actions.onMove(1)}
						>
							{m.dashboard_move_later()}
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger disabled={disabled}>
								{m.tile_move_to()}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="p-0">
								<DashboardPicker
									userId={userId}
									reference={reference}
									exclude={dashboardId}
									onPick={(target) => void copyTo(target, true)}
								/>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger disabled={disabled}>
								{m.tile_copy_to()}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="p-0">
								<DashboardPicker
									userId={userId}
									reference={reference}
									exclude={dashboardId}
									onPick={(target) => void copyTo(target, false)}
								/>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuItem
							variant="destructive"
							disabled={disabled}
							onSelect={actions.onRemove}
						>
							{m.dashboard_remove_tile()}
						</DropdownMenuItem>
					</>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuSub>
					<DropdownMenuSubTrigger disabled={!tools.data}>
						{m.tile_export()}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuLabel className="text-xs text-muted-foreground uppercase">
							{m.tile_file_type()}
						</DropdownMenuLabel>
						<DropdownMenuItem
							onSelect={() =>
								void exported(async () =>
									download(await png(), fileName(name, "png"), "image/png"),
								)
							}
						>
							.png
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() =>
								void exported(async () => {
									const text = csv();
									if (text) download(text, fileName(name, "csv"), "text/csv");
								})
							}
						>
							.csv
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-xs text-muted-foreground uppercase">
							{m.tile_clipboard()}
						</DropdownMenuLabel>
						<DropdownMenuItem
							onSelect={() =>
								void exported(async () => {
									const text = csv();
									if (text) await navigator.clipboard.writeText(text);
								}, m.tile_csv_copied())
							}
						>
							CSV
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuItem
					disabled={!tools.data}
					onSelect={() =>
						void exported(
							() =>
								navigator.clipboard.write([
									// A promised blob keeps the copy inside the click, as Safari requires.
									new ClipboardItem({ "image/png": png() }),
								]),
							m.tile_png_copied(),
						)
					}
				>
					{m.tile_copy_png()}
				</DropdownMenuItem>
				<DropdownMenuItem
					disabled={tools.fetching}
					className="flex-col items-start gap-0"
					onSelect={tools.refresh}
				>
					{m.tile_refresh_data()}
					{tools.computedAt && (
						<span className="flex items-center gap-1 text-xs text-muted-foreground">
							{m.dashboard_info_computed()}{" "}
							<TimeDisplay value={tools.computedAt} mode="relative" />
						</span>
					)}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
