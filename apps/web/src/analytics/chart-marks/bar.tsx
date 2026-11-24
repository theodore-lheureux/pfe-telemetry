import { Bar } from "recharts";
import type { MarkProps } from "./types";

export function BarMark({
	entry,
	opacity,
	values,
	stacked,
}: MarkProps & { stacked: boolean }) {
	return (
		<Bar
			dataKey={entry.key}
			fill={entry.color}
			fillOpacity={opacity}
			stackId={stacked ? "stack" : undefined}
			radius={stacked ? 0 : [3, 3, 0, 0]}
			isAnimationActive={false}
		>
			{values}
		</Bar>
	);
}
