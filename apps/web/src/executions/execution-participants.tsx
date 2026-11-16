import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { groupBy } from "es-toolkit";
import { TimeDisplay } from "../components/time-display";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import type { ExecutionFact } from "./contracts";

function FactInterval({ fact }: { fact: ExecutionFact }) {
	return (
		<dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
			<dt>{m.execution_first_seen()}</dt>
			<dd>
				<TimeDisplay value={fact.firstSeen} />
			</dd>
			<dt>{m.execution_last_seen()}</dt>
			<dd>
				<TimeDisplay value={fact.lastSeen} />
			</dd>
			<dt>{m.execution_interval_end()}</dt>
			<dd>
				{fact.ended ? (
					<TimeDisplay value={fact.ended} />
				) : (
					m.execution_end_unknown()
				)}
			</dd>
		</dl>
	);
}

/** Lifecycle ends are per participant, not a distributed completion timestamp. */
export function ExecutionParticipants({ facts }: { facts: ExecutionFact[] }) {
	const nodes = groupBy(facts, (fact) => fact.nodeId);
	const number = new Intl.NumberFormat(getLocale());
	return (
		<section className="flex flex-col gap-4">
			<h2 className="text-lg font-semibold">{m.execution_memberships()}</h2>
			<p className="text-sm text-muted-foreground">
				{m.execution_intervals_hint()}
			</p>
			{Object.entries(nodes).map(([nodeId, entries]) => (
				<Card key={nodeId}>
					<CardHeader>
						<CardTitle>
							{m.execution_member_node()}:{" "}
							<code className="break-all">{nodeId}</code>
						</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						{entries
							.filter((fact) => fact.kind === 1)
							.map((fact) => (
								<section key={fact.factId} className="flex flex-col gap-2">
									<h3 className="font-medium">
										{m.execution_lifecycle()}:{" "}
										<code className="break-all text-xs">
											{fact.participantId}
										</code>
									</h3>
									<FactInterval fact={fact} />
								</section>
							))}
						<ul className="flex flex-col gap-3">
							{entries
								.filter((fact) => fact.kind === 2)
								.map((fact) => (
									<li
										key={fact.factId}
										className="flex flex-col gap-2 rounded-md border p-3"
									>
										<p className="font-medium">
											{m.execution_process_pid()}:{" "}
											{fact.pid === null ? "—" : number.format(fact.pid)}
										</p>
										<code className="break-all text-xs">
											{fact.processResourceId}
										</code>
										<p className="text-sm">
											{m.execution_process_identity()}:{" "}
											<code>
												{fact.namespaceId} / {fact.startTimeTicks}
											</code>
										</p>
										<p className="text-sm">
											{m.execution_process_owner()}:{" "}
											{fact.ownerUid === null
												? "—"
												: number.format(fact.ownerUid)}
										</p>
										<p className="text-sm">
											{m.execution_environment_variables()}:{" "}
											<code>{fact.environmentVariable}</code>
										</p>
										<FactInterval fact={fact} />
									</li>
								))}
						</ul>
						{!entries.some((fact) => fact.kind === 2) && (
							<p className="text-sm text-muted-foreground">
								{m.execution_no_memberships()}
							</p>
						)}
					</CardContent>
				</Card>
			))}
		</section>
	);
}
