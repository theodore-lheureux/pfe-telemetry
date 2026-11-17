import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import type { ReactNode } from "react";
import { TimeDisplay } from "../../components/time-display";
import { Badge } from "../../components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../../components/ui/table";
import { cn } from "../../lib/utils";
import type { ExecutionDetail } from "../contracts";
import {
	executionPeriod,
	nodeIds,
	ownerUids,
	parameterRows,
	sameValues,
} from "./context";
import { formatDuration } from "./elapsed";
import { SideSwatch } from "./side-swatch";

// Narrow columns wrap a date and time instead of overflowing into the next one.
const WRAPPED_TIME = "text-left whitespace-normal";

interface Row {
	id: string;
	label: ReactNode;
	values: [ReactNode, ReactNode];
	differs: boolean;
}

function NotRecorded() {
	return (
		<span className="text-muted-foreground italic">
			{m.execution_compare_not_recorded()}
		</span>
	);
}

function Codes({ values }: { values: (string | number)[] }) {
	if (!values.length) return <NotRecorded />;
	return (
		<span className="flex flex-wrap gap-1.5">
			{values.map((value) => (
				<code key={value} className="rounded bg-muted px-1 py-0.5 text-xs">
					{value}
				</code>
			))}
		</span>
	);
}

function contextRows(a: ExecutionDetail, b: ExecutionDetail): Row[] {
	const locale = getLocale();
	const number = new Intl.NumberFormat(locale);
	const periods = [executionPeriod(a), executionPeriod(b)] as const;
	const durations = periods.map(
		(period) => period.to.getTime() - period.from.getTime(),
	);
	const owners = [ownerUids(a), ownerUids(b)] as const;
	const parameters = parameterRows(a.parameters, b.parameters);
	return [
		{
			id: "key",
			label: m.execution_key(),
			values: [
				<Codes key="a" values={[a.executionKey]} />,
				<Codes key="b" values={[b.executionKey]} />,
			],
			differs: false,
		},
		{
			id: "version",
			label: m.execution_workload_version(),
			values: [
				a.workloadVersion ?? <NotRecorded />,
				b.workloadVersion ?? <NotRecorded />,
			],
			differs: a.workloadVersion !== b.workloadVersion,
		},
		{
			id: "started",
			label: m.execution_compare_started(),
			values: [
				<TimeDisplay
					key="a"
					value={periods[0].from}
					className={WRAPPED_TIME}
				/>,
				<TimeDisplay
					key="b"
					value={periods[1].from}
					className={WRAPPED_TIME}
				/>,
			],
			differs: false,
		},
		{
			id: "duration",
			label: m.execution_compare_duration(),
			values: [
				<span key="a" className="tabular-nums">
					{formatDuration(durations[0], locale)}
				</span>,
				<span key="b" className="tabular-nums">
					{formatDuration(durations[1], locale)}
				</span>,
			],
			differs: durations[0] !== durations[1],
		},
		...parameters.map(
			(row): Row => ({
				id: `parameter:${row.key}`,
				label: (
					<span className="flex flex-wrap items-center gap-1.5">
						{m.execution_compare_parameter()}
						<code className="rounded bg-muted px-1 py-0.5 text-xs">
							{row.key}
						</code>
					</span>
				),
				values: [
					row.values[0] ?? <NotRecorded />,
					row.values[1] ?? <NotRecorded />,
				],
				differs: row.differs,
			}),
		),
		{
			id: "nodes",
			label: m.execution_node_count(),
			values: [
				<span key="a" className="tabular-nums">
					{number.format(a.nodeCount)}
				</span>,
				<span key="b" className="tabular-nums">
					{number.format(b.nodeCount)}
				</span>,
			],
			differs:
				a.nodeCount !== b.nodeCount || !sameValues(nodeIds(a), nodeIds(b)),
		},
		{
			id: "participants",
			label: m.execution_participant_count(),
			values: [
				<span key="a" className="tabular-nums">
					{number.format(a.participantCount)}
				</span>,
				<span key="b" className="tabular-nums">
					{number.format(b.participantCount)}
				</span>,
			],
			differs: a.participantCount !== b.participantCount,
		},
		{
			id: "owners",
			label: m.execution_compare_owners(),
			values: [
				<Codes key="a" values={owners[0]} />,
				<Codes key="b" values={owners[1]} />,
			],
			differs: !sameValues(owners[0], owners[1]),
		},
		{
			id: "environment",
			label: m.execution_environment_variables(),
			values: [
				<Codes key="a" values={a.environmentVariables} />,
				<Codes key="b" values={b.environmentVariables} />,
			],
			differs: !sameValues(a.environmentVariables, b.environmentVariables),
		},
	];
}

/** What each execution recorded about itself, side by side, with differences marked. */
export function ContextTable({
	executions,
}: {
	executions: [ExecutionDetail, ExecutionDetail];
}) {
	const rows = contextRows(...executions);
	const differences = rows.filter((row) => row.differs).length;
	return (
		<section
			aria-labelledby="execution-compare-context"
			className="flex flex-col gap-3"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h2
					id="execution-compare-context"
					className="text-lg font-semibold text-balance"
				>
					{m.execution_compare_context()}
				</h2>
				<p className="text-sm text-muted-foreground tabular-nums">
					{m.execution_compare_differences({
						count: new Intl.NumberFormat(getLocale()).format(differences),
					})}
				</p>
			</div>
			<div className="overflow-hidden rounded-lg border bg-card">
				<Table className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead className="w-32 sm:w-[28%]">
								<span className="sr-only">
									{m.execution_compare_attribute()}
								</span>
							</TableHead>
							{executions.map((execution, side) => (
								<TableHead
									key={execution.executionKey}
									className="h-auto py-2 align-top whitespace-normal"
								>
									<span className="flex min-w-0 items-center gap-2">
										<SideSwatch side={side} />
										<span className="wrap-anywhere">{execution.name}</span>
									</span>
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow
								key={row.id}
								data-differs={row.differs || undefined}
								className={cn(row.differs && "bg-accent/40")}
							>
								<TableCell className="align-top font-medium whitespace-normal hyphens-auto">
									<span className="flex flex-wrap items-center gap-1.5">
										{row.label}
										{row.differs && (
											<Badge variant="secondary">
												{m.execution_compare_differs()}
											</Badge>
										)}
									</span>
								</TableCell>
								{row.values.map((value, side) => (
									<TableCell
										// biome-ignore lint/suspicious/noArrayIndexKey: the two sides are fixed positions.
										key={side}
										className="align-top whitespace-normal wrap-anywhere"
									>
										{value}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			{/* Nothing collects these yet; they become rows once a source records them. */}
			<p className="text-sm text-muted-foreground text-pretty">
				{m.execution_compare_unrecorded()}
			</p>
		</section>
	);
}
