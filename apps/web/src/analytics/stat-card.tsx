import { cn } from "cn";
import type { ReactNode } from "react";
import { LoadingBar } from "../components/loading-bar";
import { Skeleton } from "../components/ui/skeleton";
import { type ChartPoint, Sparkline } from "./charts";

/**
 * A headline value with a sparkline for the fleet overview.
 * With `onSelect` it is a toggle button that picks what a larger chart shows.
 */
export function StatCard({
	title,
	value,
	aside,
	detail,
	points,
	bucketSeconds,
	color,
	hydrated,
	selected,
	selectLabel,
	onSelect,
	loading,
	pending,
	fill = false,
}: {
	title: string;
	value: string;
	aside?: ReactNode;
	detail?: string;
	points: ChartPoint[];
	bucketSeconds: number;
	color?: string;
	hydrated: boolean;
	selected?: boolean;
	selectLabel?: string;
	onSelect?: () => void;
	/** Shows the loading bar while its data reloads. */
	loading?: boolean;
	/** No value yet: placeholders stand in for the value, detail and sparkline. */
	pending?: boolean;
	/** Stretches to its parent's height, giving the sparkline the extra space. */
	fill?: boolean;
}) {
	const body = (
		<>
			<LoadingBar active={!!loading} />
			<div className="flex flex-col gap-1 px-4 pt-3">
				<div className="flex items-center justify-between gap-2">
					<span className="truncate text-sm font-medium">{title}</span>
					{aside}
				</div>
				{pending ? (
					<>
						<Skeleton className="my-1 h-7 w-20" />
						<Skeleton className="h-3 w-28" />
					</>
				) : (
					<>
						<span className="text-3xl font-semibold tracking-tight tabular-nums">
							{value}
						</span>
						{detail && (
							<span className="text-xs text-muted-foreground">{detail}</span>
						)}
					</>
				)}
			</div>
			<div className={cn("mt-2", fill ? "min-h-12 flex-1" : "h-12")}>
				{pending && <Skeleton className="mx-4 h-9" />}
				{hydrated && !pending && (
					<Sparkline
						points={points}
						bucketSeconds={bucketSeconds}
						color={color}
					/>
				)}
			</div>
		</>
	);
	const frame = cn(
		"relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-left",
		fill && "h-full",
	);
	if (!onSelect) return <div className={frame}>{body}</div>;
	return (
		<button
			type="button"
			aria-pressed={selected}
			aria-label={selectLabel}
			onClick={onSelect}
			className={cn(
				frame,
				"transition-colors hover:border-ring focus-visible:outline-2 focus-visible:outline-ring",
				selected && "border-primary ring-1 ring-primary",
			)}
		>
			{body}
		</button>
	);
}
