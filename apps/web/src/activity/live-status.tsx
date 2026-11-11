import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import {
	ListFilterIcon,
	PauseIcon,
	PlayIcon,
	PlusIcon,
	RefreshCwIcon,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { LiveSnapshot } from "./contracts";

export type PausedBy = "user" | "inspector" | "hover";

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
	);
}

/** Live status and new-packet count on the left; reload, filters and pause on the right. */
export function LiveToolbar({
	live,
	pausedBy,
	unseen,
	hydrated,
	onReload,
	onPause,
	onResume,
}: {
	live: LiveSnapshot | undefined;
	pausedBy: PausedBy | null;
	/** Packets that arrived while the list was frozen. */
	unseen: number;
	hydrated: boolean;
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
