import { Line } from "recharts";
import type { MarkProps } from "./types";

export function LineMark({ entry, curve, opacity, values }: MarkProps) {
	return (
		<Line
			dataKey={entry.key}
			type={curve}
			stroke={entry.color}
			strokeOpacity={opacity}
			strokeWidth={2}
			strokeDasharray={entry.coincident ? "6 6" : undefined}
			dot={false}
			activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
			isAnimationActive={false}
		>
			{values}
		</Line>
	);
}
