import { cn } from "../lib/utils";

/** A cell color between the muted background and the first series color. */
export function heatColor(ratio: number) {
	return `color-mix(in oklab, var(--viz-1) ${100 * Math.min(1, Math.max(0, ratio))}%, var(--muted))`;
}

export function ColorScale({
	from,
	to,
	width,
}: {
	from: string;
	to: string;
	width: string;
}) {
	return (
		<>
			<span className="tabular-nums">{from}</span>
			<span
				aria-hidden="true"
				className={cn(
					"h-2 rounded-sm bg-[linear-gradient(to_right,var(--muted),var(--viz-1))]",
					width,
				)}
			/>
			<span className="tabular-nums">{to}</span>
		</>
	);
}

export function TooltipSwatch({
	color,
	block = false,
	faded = false,
}: {
	color: string;
	block?: boolean;
	faded?: boolean;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"shrink-0",
				block ? "size-2.5 rounded-[2px]" : "h-0.5 w-3 rounded-full",
				faded && "opacity-50",
			)}
			style={{ background: color }}
		/>
	);
}
