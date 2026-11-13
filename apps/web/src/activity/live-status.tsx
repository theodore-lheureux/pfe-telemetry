import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import {
	ListFilterIcon,
	PauseIcon,
	PlayIcon,
	PlusIcon,
	RefreshCwIcon,
} from "lucide-react";
import { FacetFilter } from "../analytics/saved/facet-filter";
import { Button } from "../components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import type { LiveSnapshot } from "./contracts";
import { MAX_LIVE_NODES } from "./live-filter";

export type PausedBy = "user" | "inspector" | "hover";

function statusText(live: LiveSnapshot | undefined, pausedBy: PausedBy | null) {
	if (pausedBy === "inspector") return m.activity_paused_inspecting();
	if (pausedBy === "hover") return m.activity_paused_hover();
	if (pausedBy !== null) return m.activity_paused();
	if (live?.status === "connected") return m.activity_connected();
	if (live?.status === "disconnected") return m.activity_disconnected();
	return m.activity_connecting();
}

/** The live feed's connection, pause reason, reporting nodes and packet rate. */
export function LiveStatus({
	live,
	pausedBy,
}: {
	live: LiveSnapshot | undefined;
	pausedBy: PausedBy | null;
}) {
	const numbers = new Intl.NumberFormat(getLocale());
	const paused = pausedBy !== null;
	const status = statusText(live, pausedBy);
	const connected = live?.status === "connected";
	return (
		<span
			role="status"
			title={m.activity_reporting_note()}
			className="inline-flex h-8 items-center gap-2 rounded-md bg-muted px-3 text-sm"
		>
			<span
				aria-hidden="true"
				className={cn(
					"size-2 rounded-full",
					!paused && !connected && "bg-muted-foreground",
					!paused && connected && "bg-emerald-500 motion-safe:animate-pulse",
					paused && "bg-amber-500",
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
	);
}

/** Live status and new-packet count on the left; reload, filters and pause on the right. */
export function LiveToolbar({
	live,
	pausedBy,
	unseen,
	hydrated,
	nodes,
	selectedNodes,
	onNodes,
	onReload,
	onPause,
	onResume,
}: {
	live: LiveSnapshot | undefined;
	pausedBy: PausedBy | null;
	/** Packets that arrived while the list was frozen. */
	unseen: number;
	hydrated: boolean;
	/** The project's nodes, to filter by. */
	nodes: { id: string; hostname: string }[];
	selectedNodes: string[];
	onNodes: (nodes: string[]) => void;
	onReload: () => void;
	onPause: () => void;
	onResume: () => void;
}) {
	const paused = pausedBy !== null;
	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<LiveStatus live={live} pausedBy={pausedBy} />
				{unseen > 0 && (
					<Button variant="secondary" size="sm" onClick={onResume}>
						{m.activity_show_new({
							count: new Intl.NumberFormat(getLocale()).format(unseen),
						})}
					</Button>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					size="icon"
					aria-label={m.activity_reload()}
					title={m.activity_reload()}
					disabled={!hydrated || paused}
					onClick={onReload}
				>
					<RefreshCwIcon aria-hidden="true" />
				</Button>
				<FacetFilter
					label={m.activity_node_filter()}
					icon={<ListFilterIcon aria-hidden="true" />}
					searchable
					disabled={!hydrated}
					selected={selectedNodes}
					onChange={(next) => onNodes(next.slice(0, MAX_LIVE_NODES))}
					options={nodes.map((node) => ({
						value: node.id,
						label: node.hostname,
					}))}
				/>
				{/* Live notifications carry no attributes, so only Explorer filters by them. */}
				<Tooltip>
					<TooltipTrigger asChild>
						{/* Stays focusable, unlike a disabled button, so the reason can be read. */}
						<Button
							variant="outline"
							aria-disabled="true"
							className="cursor-not-allowed opacity-50"
						>
							<PlusIcon aria-hidden="true" />
							{m.activity_attribute_filter()}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{m.activity_live_attribute_unavailable()}
					</TooltipContent>
				</Tooltip>
				<Button
					variant="outline"
					disabled={!hydrated}
					onClick={paused ? onResume : onPause}
				>
					{paused ? (
						<PlayIcon aria-hidden="true" />
					) : (
						<PauseIcon aria-hidden="true" />
					)}
					{paused ? m.activity_resume() : m.activity_pause()}
				</Button>
			</div>
		</>
	);
}
