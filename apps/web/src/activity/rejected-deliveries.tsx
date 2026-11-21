import { m } from "@recount/i18n/messages";
import { TimeDisplay } from "../components/time-display";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table";
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

export function RejectedDeliveries({
	result,
}: {
	result: OperationResult<
		{ id: string; source: string; received: Date; reason: string }[]
	>;
}) {
	const rows = result.data;
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{m.activity_rejected_deliveries()}</h2>
				</CardTitle>
			</CardHeader>
			<CardContent>
				{!rows && <p role="status">{m.activity_rejected_unavailable()}</p>}
				{rows?.length === 0 && <p>{m.activity_rejected_empty()}</p>}
				{rows && rows.length > 0 && (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{m.activity_rejected_received()}</TableHead>
								<TableHead>{m.activity_node()}</TableHead>
								<TableHead>{m.activity_rejected_reason()}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<TableRow key={row.id}>
									<TableCell>
										<TimeDisplay value={row.received} />
									</TableCell>
									<TableCell className="font-mono">{row.source}</TableCell>
									<TableCell>
										{(reasons.get(row.reason) ?? m.activity_reject_unknown)()}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
