import type { ReactNode } from "react";
import type { ChartSeries } from "../charts";

export interface MarkProps {
	entry: ChartSeries;
	curve: "linear" | "monotone";
	opacity: number;
	values: ReactNode;
}
