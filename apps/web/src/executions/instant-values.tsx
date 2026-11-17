import { m } from "@recount/i18n/messages";
import { useTable } from "@tanstack/react-table";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { INTERVALS, type Interval } from "../analytics/contracts";
import { INTERVAL_LABEL } from "../analytics/insight/labels";
import { DataTable } from "../components/data-table";
import { TimeDisplay } from "../components/time-display";
import { Button } from "../components/ui/button";
import { ButtonGroup } from "../components/ui/button-group";
import type { InstantValue } from "./instant";
import {
	type InstantValueMeta,
	instantValueColumns,
	instantValueFeatures,
} from "./instant-value-columns";

function intervalText(seconds: number) {
	const interval = (Object.entries(INTERVALS) as [Interval, number][]).find(
		([, step]) => step === seconds,
	)?.[0];
	return interval ? INTERVAL_LABEL[interval]() : String(seconds);
}

/** Every measure's value on each shown machine during the selected bucket. */
export function InstantValues({
	values,
	bucketMs,
	bucketSeconds,
	first,
	last,
	selected,
	meta,
	onInstant,
}: {
	values: InstantValue[];
	bucketMs: number;
	bucketSeconds: number;
	/** The first and last bucket starts, which bound stepping. */
	first: number;
	last: number;
	/** Whether an instant was chosen, rather than the latest values shown. */
	selected: boolean;
	meta: InstantValueMeta;
	/** Picks another bucket, or the latest values when null. */
	onInstant: (at: number | null) => void;
}) {
	const step = bucketSeconds * 1000;
	const table = useTable({
		features: instantValueFeatures,
		data: values,
		columns: instantValueColumns,
		meta,
		getRowId: (row) => `${row.measure.name}/${row.node}`,
	});
	return (
		<section
			aria-labelledby="execution-instant-values"
			className="flex flex-col gap-3"
		>
			<div className="flex flex-wrap items-end justify-between gap-2">
				<div className="flex flex-col gap-0.5">
					<h3 id="execution-instant-values" className="font-medium">
						{m.execution_timeline_values()}
					</h3>
					<p className="text-sm text-muted-foreground tabular-nums">
						{m.execution_timeline_values_bucket({
							duration: intervalText(bucketSeconds),
						})}{" "}
						<TimeDisplay value={bucketMs} />
					</p>
				</div>
				<div className="flex items-center gap-2">
					{selected && (
						<Button variant="ghost" size="sm" onClick={() => onInstant(null)}>
							{m.execution_timeline_show_latest()}
						</Button>
					)}
					<ButtonGroup>
						<Button
							variant="outline"
							size="icon"
							aria-label={m.execution_timeline_previous()}
							disabled={bucketMs <= first}
							onClick={() => onInstant(bucketMs - step)}
						>
							<ChevronLeftIcon aria-hidden="true" />
						</Button>
						<Button
							variant="outline"
							size="icon"
							aria-label={m.execution_timeline_next()}
							disabled={bucketMs >= last}
							onClick={() => onInstant(bucketMs + step)}
						>
							<ChevronRightIcon aria-hidden="true" />
						</Button>
					</ButtonGroup>
				</div>
			</div>
			<DataTable table={table} label={m.execution_timeline_values()} />
		</section>
	);
}
