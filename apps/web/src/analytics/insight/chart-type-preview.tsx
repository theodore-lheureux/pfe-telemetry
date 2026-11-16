import type { DisplayType } from "./draft";

const HEIGHTS = [28, 42, 35, 58, 49, 70];

/** Decorative samples, not query results. */
export function ChartTypePreview({ type }: { type: DisplayType }) {
	if (type === "stat")
		return (
			<div
				aria-hidden="true"
				className="flex h-24 items-center justify-center bg-muted/40 text-4xl font-semibold tabular-nums"
			>
				128
			</div>
		);
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 200 96"
			className="h-24 w-full bg-muted/40 text-primary"
		>
			<path
				d="M16 12V82H188"
				fill="none"
				className="stroke-border"
				strokeDasharray="3 3"
			/>
			{type === "table" &&
				[22, 40, 58, 76].map((y, index) => (
					<g key={y}>
						<rect
							x="24"
							y={y - 5}
							width="42"
							height="6"
							rx="3"
							className="fill-muted-foreground/25"
						/>
						<rect
							x="86"
							y={y - 5}
							width={90 - index * 18}
							height="6"
							rx="3"
							fill="currentColor"
							opacity={1 - index * 0.16}
						/>
					</g>
				))}
			{(type === "bar" || type === "stacked") &&
				HEIGHTS.map((height, index) => (
					<g key={height}>
						<rect
							x={24 + index * 27}
							y={82 - height}
							width="17"
							height={height}
							rx="2"
							fill="currentColor"
							opacity={0.45 + index * 0.1}
						/>
						{type === "stacked" && (
							<rect
								x={24 + index * 27}
								y={82 - height}
								width="17"
								height={height * 0.4}
								rx="2"
								className="fill-chart-2"
							/>
						)}
					</g>
				))}
			{(type === "line" || type === "area") && (
				<>
					{type === "area" && (
						<path
							d="M20 70L50 57L80 62L110 35L140 42L180 18V82H20Z"
							fill="currentColor"
							opacity="0.15"
						/>
					)}
					<path
						d="M20 70L50 57L80 62L110 35L140 42L180 18"
						fill="none"
						stroke="currentColor"
						strokeWidth="3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d="M20 77L50 72L80 70L110 58L140 61L180 43"
						fill="none"
						className="stroke-chart-2"
						strokeWidth="3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</>
			)}
		</svg>
	);
}
