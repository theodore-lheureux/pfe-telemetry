import { m } from "@recount/i18n/messages";
import { type ColumnDef, tableFeatures, useTable } from "@tanstack/react-table";
import { DataTable } from "../components/data-table";
import { TimeDisplay } from "../components/time-display";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import type { OperationResult } from "../lib/operation-result";

const reasons = new Map([
	["raw_too_large", m.activity_reject_raw_size],
	["invalid_envelope", m.activity_reject_envelope],
	["routing_key_mismatch", m.activity_reject_routing],
	["invalid_otlp", m.activity_reject_otlp],
	["retained_validation", m.activity_reject_validation],
	["projection", m.activity_reject_projection],
	["normalized_record_too_large", m.activity_reject_normalized_size],
]);

type RejectedDelivery = {
	id: string;
	source: string;
	received: Date;
	reason: string;
};

const features = tableFeatures({});
const columns: ColumnDef<typeof features, RejectedDelivery>[] = [
	{
		id: "received",
		header: () => m.activity_rejected_received(),
		cell: ({ row }) => <TimeDisplay value={row.original.received} />,
	},
	{
		id: "source",
		header: () => m.activity_node(),
		cell: ({ row }) => row.original.source,
		meta: { className: "font-mono" },
	},
	{
		id: "reason",
		header: () => m.activity_rejected_reason(),
		cell: ({ row }) =>
			(reasons.get(row.original.reason) ?? m.activity_reject_unknown)(),
	},
];
const empty: RejectedDelivery[] = [];

export function RejectedDeliveries({
	result,
}: {
	result: OperationResult<RejectedDelivery[]>;
}) {
	const table = useTable({
		features,
		data: result.data ?? empty,
		columns,
		getRowId: (row) => row.id,
	});
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{m.activity_rejected_deliveries()}</h2>
				</CardTitle>
			</CardHeader>
			<CardContent>
				{result.error ? (
					<p role="status">{m.activity_rejected_unavailable()}</p>
				) : (
					<DataTable
						table={table}
						label={m.activity_rejected_deliveries()}
						empty={m.activity_rejected_empty()}
					/>
				)}
			</CardContent>
		</Card>
	);
}
