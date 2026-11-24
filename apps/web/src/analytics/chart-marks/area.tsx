import { Area } from "recharts";
import type { MarkProps } from "./types";

export function AreaMark({
	entry,
	curve,
	opacity,
	values,
	gradient,
}: MarkProps & { gradient?: string }) {
	return (
		<Area
			dataKey={entry.key}
			type={curve}
			stroke={entry.color}
			strokeOpacity={opacity}
			strokeWidth={2}
			fill={gradient ? `url(#${gradient})` : entry.color}
			fillOpacity={(gradient ? 1 : 0.12) * opacity}
			dot={false}
			activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
			isAnimationActive={false}
		>
			{values}
		</Area>
	);
}
