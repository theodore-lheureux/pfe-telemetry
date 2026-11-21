import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { useId, useState } from "react";
import { resolveRange } from "../../components/date-range/date-range";
import { useDisplayTimeZone } from "../../components/time-display";
import {
	NativeSelect,
	NativeSelectOption,
} from "../../components/ui/native-select";
import { Skeleton } from "../../components/ui/skeleton";
import { unwrapOperation } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import { getHistogram } from "../analytics.functions";
import type { MetricDefinition } from "../contracts";
import type { InsightDraft } from "./draft";
import { HistogramHeatmap } from "./histogram-heatmap";

export function HistogramPanel({
	reference,
	userId,
	metrics,
	range,
	now,
}: {
	reference: ProjectReference;
	userId: string;
	metrics: MetricDefinition[];
	range: InsightDraft["range"];
	now: Date;
}) {
	const id = useId();
	const hydrated = useHydrated();
	const zone = useDisplayTimeZone();
	const locale = getLocale();
	const [selection, setSelection] = useState("");
	const choices = metrics.filter(
		(metric) =>
			metric.kind === 3 &&
			metric.temporality === 1 &&
			metric.status !== "hidden",
	);
	const key = (metric: MetricDefinition) =>
		JSON.stringify([metric.name, metric.unit]);
	const metric = choices.find((choice) => key(choice) === selection);
	const { from, to } = resolveRange(range, now, zone, locale);
	const input = metric && {
		...reference,
		metric: metric.name,
		unit: metric.unit,
		from,
		to: to ?? now,
	};
	const result = useQuery({
		queryKey: ["histogram", userId, input],
		queryFn: input
			? async ({ signal }) =>
					unwrapOperation(await getHistogram({ data: input, signal }))
			: undefined,
		enabled: hydrated && !!input,
		retry: false,
	});
	if (!choices.length) return null;
	return (
		<section className="min-w-0 space-y-3 rounded-lg border bg-card p-4">
			<label htmlFor={id} className="block font-medium">
				{m.histogram_title()}
			</label>
			<NativeSelect
				id={id}
				value={metric ? selection : ""}
				disabled={!hydrated}
				onChange={(event) => setSelection(event.target.value)}
			>
				<NativeSelectOption value="">{m.histogram_choose()}</NativeSelectOption>
				{choices.map((choice) => (
					<NativeSelectOption key={key(choice)} value={key(choice)}>
						{choice.name} {choice.unit && `(${choice.unit})`}
					</NativeSelectOption>
				))}
			</NativeSelect>
			{metric && (
				<p className="text-sm text-muted-foreground">{m.histogram_context()}</p>
			)}
			{metric && result.isLoading && <Skeleton className="h-32 w-full" />}
			{result.isError && <p role="alert">{m.insight_unavailable()}</p>}
			{result.data && input && (
				<HistogramHeatmap
					rows={result.data.rows}
					unit={metric?.unit ?? ""}
					limited={result.data.limited}
					zone={zone}
					timeline={{
						from: input.from.getTime(),
						to: input.to.getTime(),
						step: result.data.step,
					}}
				/>
			)}
		</section>
	);
}
