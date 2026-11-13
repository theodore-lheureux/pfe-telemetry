import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { ChevronDownIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { TimeDisplay } from "../../components/time-display";
import { Button } from "../../components/ui/button";
import { ButtonGroup } from "../../components/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Switch } from "../../components/ui/switch";

const INTERVAL_MINUTES = [5, 15, 30, 60] as const;
type IntervalMinutes = (typeof INTERVAL_MINUTES)[number];

interface AutoRefresh {
	on: boolean;
	minutes: IntervalMinutes;
}
const DEFAULT_AUTO: AutoRefresh = { on: false, minutes: 30 };

function storageKey(dashboardId: string) {
	return `recount.dashboard-refresh.${dashboardId}`;
}

/** This viewer's auto refresh choice for a dashboard, kept in this browser only. */
function useAutoRefresh(dashboardId: string) {
	const [auto, setAuto] = useState(DEFAULT_AUTO);
	useEffect(() => {
		try {
			const stored = JSON.parse(
				localStorage.getItem(storageKey(dashboardId)) ?? "null",
			) as Partial<AutoRefresh> | null;
			if (
				stored &&
				INTERVAL_MINUTES.includes(stored.minutes as IntervalMinutes)
			)
				setAuto({
					on: stored.on === true,
					minutes: stored.minutes as IntervalMinutes,
				});
		} catch {
			// Unavailable storage leaves auto refresh off.
		}
	}, [dashboardId]);
	const change = (next: AutoRefresh) => {
		setAuto(next);
		try {
			localStorage.setItem(storageKey(dashboardId), JSON.stringify(next));
		} catch {
			// The choice still applies until the page closes.
		}
	};
	return [auto, change] as const;
}

function intervalText(minutes: IntervalMinutes) {
	const hours = minutes >= 60;
	return new Intl.NumberFormat(getLocale(), {
		style: "unit",
		unit: hours ? "hour" : "minute",
		unitDisplay: "narrow",
	}).format(hours ? minutes / 60 : minutes);
}

/**
 * When the tiles were last refreshed, a button to refresh them all, and auto refresh,
 * which runs only while the page is visible.
 */
export function RefreshControl({
	dashboardId,
	refreshedAt,
	progress,
	disabled,
	onRefresh,
}: {
	dashboardId: string;
	refreshedAt: Date;
	/** Tiles loading together, while any are. */
	progress: { done: number; total: number } | null;
	disabled: boolean;
	onRefresh: () => void;
}) {
	const [auto, setAuto] = useAutoRefresh(dashboardId);
	useEffect(() => {
		if (!auto.on || disabled) return;
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") onRefresh();
		}, auto.minutes * 60_000);
		return () => clearInterval(timer);
	}, [auto, disabled, onRefresh]);
	return (
		<div className="flex items-center gap-2">
			<span
				className="hidden items-center gap-1 text-sm text-muted-foreground lg:flex"
				aria-live="polite"
			>
				{progress ? (
					<>
						<LoaderCircleIcon
							aria-hidden="true"
							className="size-4 motion-safe:animate-spin"
						/>
						{m.dashboard_loaded_count(progress)}
					</>
				) : (
					<>
						{m.dashboard_last_refreshed()}{" "}
						<TimeDisplay value={refreshedAt} mode="relative" />
					</>
				)}
			</span>
			<ButtonGroup>
				<Button variant="outline" disabled={disabled} onClick={onRefresh}>
					<RefreshCwIcon aria-hidden="true" />
					{m.dashboard_refresh_all()}
					{auto.on && (
						<span
							className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground"
							title={m.dashboard_auto_refresh_every({
								interval: intervalText(auto.minutes),
							})}
						>
							{intervalText(auto.minutes)}
						</span>
					)}
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="outline"
							size="icon"
							disabled={disabled}
							aria-label={m.dashboard_refresh_options()}
						>
							<ChevronDownIcon aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-64">
						<DropdownMenuItem
							role="menuitemcheckbox"
							aria-checked={auto.on}
							className="justify-between"
							onSelect={(event) => {
								event.preventDefault();
								setAuto({ ...auto, on: !auto.on });
							}}
						>
							{m.dashboard_auto_refresh()}
							{/* The menu item is the control; the switch only shows its state. */}
							<Switch
								checked={auto.on}
								tabIndex={-1}
								aria-hidden="true"
								className="pointer-events-none"
							/>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-xs text-muted-foreground uppercase">
							{m.dashboard_refresh_interval()}
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={String(auto.minutes)}
							onValueChange={(value) =>
								setAuto({ ...auto, minutes: Number(value) as IntervalMinutes })
							}
						>
							{INTERVAL_MINUTES.map((minutes) => (
								<DropdownMenuRadioItem
									key={minutes}
									value={String(minutes)}
									disabled={!auto.on}
									onSelect={(event) => event.preventDefault()}
								>
									{intervalText(minutes)}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</ButtonGroup>
		</div>
	);
}
