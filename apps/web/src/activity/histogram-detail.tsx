import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { bucketRange } from "../analytics/histograms";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table";
import type { PointDetail } from "./contracts";
import { formatMeasurement } from "./format";

export function hasHistogramBuckets(measurement: PointDetail["measurement"]) {
	const { bucket_counts, explicit_bounds, metric_kind } = measurement;
	return (
		metric_kind === 3 &&
		Array.isArray(bucket_counts) &&
		Array.isArray(explicit_bounds) &&
		bucket_counts.length === explicit_bounds.length + 1
	);
}

export function HistogramDetail({
	measurement,
	metric,
}: Pick<PointDetail, "measurement"> & { metric: string }) {
	const { bucket_counts, explicit_bounds, count, sum, min, max, unit } =
		measurement;
	if (!Array.isArray(bucket_counts) || !Array.isArray(explicit_bounds))
		return null;
	const bounds = explicit_bounds.map(Number);
	const locale = getLocale();
	const storedUnit = typeof unit === "string" ? unit : "";
	const format = (value: number) =>
		formatMeasurement(value, storedUnit, locale, 0, metric).text;
	const integers = new Intl.NumberFormat(locale);
	const mean =
		typeof sum === "number" && Number(count) > 0 ? sum / Number(count) : null;
	return (
		<div className="space-y-3 px-3 py-2">
			<dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums">
				{(
					[
						[
							m.histogram_count(),
							count == null ? null : integers.format(BigInt(String(count))),
						],
						[m.histogram_mean(), mean],
						[m.histogram_min(), typeof min === "number" ? min : null],
						[m.histogram_max(), typeof max === "number" ? max : null],
					] as const
				).map(([label, value]) => (
					<div key={label} className="flex gap-1.5">
						<dt className="text-muted-foreground">{label}</dt>
						<dd>
							{typeof value === "number" ? format(value) : (value ?? "—")}
						</dd>
					</div>
				))}
			</dl>
			<div className="max-h-64 max-w-xl overflow-auto rounded-md border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{m.histogram_bucket()} </TableHead>
							<TableHead className="text-right">
								{m.histogram_count()}
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{bucket_counts.map((value, index) => (
							<TableRow key={bounds[index] ?? "overflow"}>
								<TableHead scope="row">
									{bucketRange(bounds, index, format)}
								</TableHead>
								<TableCell className="text-right tabular-nums">
									{integers.format(BigInt(String(value)))}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
