import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../../components/ui/table";
import { type HistogramWindow, histogramRange } from "../histograms";

export function HistogramHeatmap({
	rows,
	unit,
	limited,
	zone,
}: {
	rows: HistogramWindow[];
	unit: string;
	limited: boolean;
	zone: string;
}) {
	const locale = getLocale();
	const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 8 });
	const time = new Intl.DateTimeFormat(locale, {
		dateStyle: "short",
		timeStyle: "medium",
		timeZone: zone,
	});
	const layouts = new Map<string, HistogramWindow[]>();
	for (const row of rows) {
		const key = JSON.stringify(row.bounds);
		const layout = layouts.get(key);
		if (layout) layout.push(row);
		else layouts.set(key, [row]);
	}
	if (!rows.length) return <p>{m.histogram_empty()}</p>;
	return (
		<div className="space-y-4">
			{limited && <p role="status">{m.histogram_limited()}</p>}
			{[...layouts].map(([key, windows]) => {
				const bounds = windows[0].bounds;
				const peak = Math.max(
					1,
					...windows.flatMap((window) => window.counts.map(Number)),
				);
				return (
					<Table key={key}>
						<TableHeader>
							<TableRow>
								<TableHead>
									{m.histogram_bucket()} {unit && `(${unit})`}
								</TableHead>
								{windows.map((window) => (
									<TableHead key={window.bucket}>
										{time.format(Number(window.bucket))}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{Array.from({ length: bounds.length + 1 }, (_, index) => (
								<TableRow key={bounds[index] ?? "overflow"}>
									<TableHead scope="row">
										{histogramRange(bounds, index, number)}
									</TableHead>
									{windows.map((window) => {
										const count = window.counts[index];
										return (
											<TableCell
												key={window.bucket}
												style={{
													backgroundColor: `color-mix(in oklab, var(--chart-1) ${Math.round((35 * Math.log1p(Number(count))) / Math.log1p(peak))}%, transparent)`,
												}}
											>
												{number.format(BigInt(count))}
											</TableCell>
										);
									})}
								</TableRow>
							))}
							<StatRow
								label={m.histogram_count()}
								windows={windows}
								value={(row) => BigInt(row.count)}
								format={number}
							/>
							<StatRow
								label={m.histogram_mean()}
								windows={windows}
								value={(row) => row.mean}
								format={number}
							/>
							<StatRow
								label={m.histogram_min()}
								windows={windows}
								value={(row) => row.min}
								format={number}
							/>
							<StatRow
								label={m.histogram_max()}
								windows={windows}
								value={(row) => row.max}
								format={number}
							/>
						</TableBody>
					</Table>
				);
			})}
		</div>
	);
}

function StatRow({
	label,
	windows,
	value,
	format,
}: {
	label: string;
	windows: HistogramWindow[];
	value: (row: HistogramWindow) => number | bigint | null;
	format: Intl.NumberFormat;
}) {
	return (
		<TableRow>
			<TableHead scope="row">{label}</TableHead>
			{windows.map((window) => {
				const stat = value(window);
				return (
					<TableCell key={window.bucket}>
						{stat === null ? "—" : format.format(stat)}
					</TableCell>
				);
			})}
		</TableRow>
	);
}
