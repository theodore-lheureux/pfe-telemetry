import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import type { ReactNode } from "react";
import { TimeDisplay } from "../components/time-display";
import type { ExecutionDetail } from "./contracts";

function Term({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="text-sm font-medium tabular-nums">{children}</dd>
		</div>
	);
}

/** The execution's metadata from its earliest lifecycle, and its observed extent. */
export function ExecutionSummary({ entry }: { entry: ExecutionDetail }) {
	const number = new Intl.NumberFormat(getLocale());
	const parameters = Object.entries(entry.parameters);
	return (
		<dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border bg-card p-4 sm:grid-cols-3 lg:grid-cols-6">
			<Term label={m.execution_node_count()}>
				{number.format(entry.nodeCount)}
			</Term>
			<Term label={m.execution_participant_count()}>
				{number.format(entry.participantCount)}
			</Term>
			<Term label={m.execution_first_seen()}>
				<TimeDisplay value={entry.firstSeen} />
			</Term>
			<Term label={m.execution_last_seen()}>
				<TimeDisplay value={entry.lastSeen} />
			</Term>
			{entry.workloadVersion && (
				<Term label={m.execution_workload_version()}>
					<span className="break-all">{entry.workloadVersion}</span>
				</Term>
			)}
			<Term label={m.execution_environment_variables()}>
				<span className="flex flex-wrap gap-1.5">
					{entry.environmentVariables.map((name) => (
						<code key={name} className="rounded bg-muted px-1.5 py-0.5 text-xs">
							{name}
						</code>
					))}
				</span>
			</Term>
			{parameters.length > 0 && (
				<div className="col-span-full flex flex-col gap-1 border-t pt-4">
					<dt className="text-xs text-muted-foreground">
						{m.execution_timeline_parameters()}
					</dt>
					<dd>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
							{parameters.map(([key, value]) => (
								<div key={key} className="contents">
									<dt>
										<code className="text-xs">{key}</code>
									</dt>
									<dd className="break-all">{value}</dd>
								</div>
							))}
						</dl>
					</dd>
				</div>
			)}
		</dl>
	);
}
