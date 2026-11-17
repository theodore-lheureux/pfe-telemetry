import { m } from "@recount/i18n/messages";
import {
	ArrowLeftRightIcon,
	GitCompareArrowsIcon,
	SearchXIcon,
} from "lucide-react";
import type { MetricDefinition } from "../../analytics/contracts";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { IconEmptyState, PageHeading } from "../../components/workspace";
import type { ProjectReference } from "../../organizations/contracts";
import type { ExecutionDetail } from "../contracts";
import { ContextTable } from "./context-table";
import { ExecutionPicker } from "./execution-picker";
import { MeasurementCharts } from "./measurement-charts";
import { TimingNote } from "./timing-note";

/** A chosen execution: its key, and its detail unless the key was not found. */
export interface ComparedSide {
	key: string;
	execution: ExecutionDetail | null;
}

const SIDE_LABELS = [m.execution_compare_first, m.execution_compare_second];

function bothFound(
	sides: [ComparedSide | null, ComparedSide | null],
): [ExecutionDetail, ExecutionDetail] | null {
	const [a, b] = sides;
	if (!a?.execution || !b?.execution) return null;
	return [a.execution, b.execution];
}

/** Two executions of a project, their recorded context and their aligned measurements. */
export function ComparePage({
	userId,
	reference,
	sides,
	catalog,
	onSelect,
	onSwap,
}: {
	userId: string;
	reference: ProjectReference;
	sides: [ComparedSide | null, ComparedSide | null];
	catalog: MetricDefinition[];
	onSelect: (side: 0 | 1, key: string) => void;
	onSwap: () => void;
}) {
	const executions = bothFound(sides);
	const missing = sides.flatMap((side) =>
		side && !side.execution ? [side.key] : [],
	);
	const picker = (side: 0 | 1) => {
		const chosen = sides[side];
		return (
			<ExecutionPicker
				userId={userId}
				reference={reference}
				label={SIDE_LABELS[side]()}
				side={side}
				selected={
					chosen && {
						key: chosen.key,
						name: chosen.execution?.name ?? chosen.key,
					}
				}
				other={sides[side === 0 ? 1 : 0]?.key}
				onSelect={(key) => onSelect(side, key)}
			/>
		);
	};
	return (
		<>
			<PageHeading title={m.execution_compare_title()}>
				{m.execution_compare_description()}
			</PageHeading>
			<div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
				{picker(0)}
				<Button
					variant="ghost"
					size="icon"
					aria-label={m.execution_compare_swap()}
					disabled={!sides[0] && !sides[1]}
					onClick={onSwap}
					className="justify-self-center"
				>
					<ArrowLeftRightIcon aria-hidden="true" />
				</Button>
				{picker(1)}
			</div>
			{missing.length > 0 && (
				<Alert variant="destructive">
					<SearchXIcon aria-hidden="true" />
					<AlertTitle>{m.execution_compare_missing()}</AlertTitle>
					<AlertDescription>
						<p className="flex flex-wrap gap-1.5">
							{missing.map((key) => (
								<code key={key}>{key}</code>
							))}
						</p>
					</AlertDescription>
				</Alert>
			)}
			{executions ? (
				<>
					<TimingNote executions={executions} />
					<ContextTable executions={executions} />
					<MeasurementCharts
						userId={userId}
						reference={reference}
						executions={executions}
						catalog={catalog}
					/>
				</>
			) : (
				<IconEmptyState
					icon={<GitCompareArrowsIcon aria-hidden="true" />}
					title={m.execution_compare_empty_title()}
					description={m.execution_compare_empty_description()}
					className="bg-card"
				/>
			)}
		</>
	);
}
