/** The chart color of each compared execution, in picker order. */
export const SIDE_COLORS = ["var(--viz-1)", "var(--viz-2)"] as const;

/** The line color an execution has in the comparison charts. */
export function SideSwatch({ side }: { side: number }) {
	return (
		<span
			aria-hidden="true"
			className="h-1 w-3 shrink-0 rounded-full"
			style={{ background: SIDE_COLORS[side] }}
		/>
	);
}
