import { m } from "@recount/i18n/messages";
import { useId } from "react";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import {
	type AttributeDefinition,
	type Combine,
	MAX_SERIES,
} from "../contracts";
import { GroupByPicker } from "../group-by-picker";
import type { InsightDraft } from "./draft";
import { AGGREGATE_LABEL, COMBINE_GROUPS } from "./labels";

// Radix Select cannot use an empty value, so "no grouping" and "each group" have sentinels.
const NO_GROUP = "-";
const EACH_GROUP = "-";

/** The breakdown attribute, how many groups to keep and whether the rest form "Other". */
export function GroupByFields({
	draft,
	attributes,
	disabled,
	onOpen,
	onChange,
}: {
	draft: InsightDraft;
	attributes: AttributeDefinition[] | undefined;
	disabled: boolean;
	/** Attributes load the first time the list opens. */
	onOpen: () => void;
	onChange: (draft: InsightDraft) => void;
}) {
	const id = useId();
	return (
		<>
			<GroupByPicker
				value={draft.groupBy ?? NO_GROUP}
				choices={[{ value: NO_GROUP, label: m.insight_group_none() }]}
				attributes={attributes}
				loading={!attributes}
				disabled={disabled}
				className="w-full max-w-none"
				onOpen={onOpen}
				onChange={(value) =>
					onChange({
						...draft,
						groupBy: value === NO_GROUP ? undefined : value,
					})
				}
			/>
			{draft.groupBy && draft.display.type !== "heatmap" && (
				<Select
					value={draft.aggregate ?? EACH_GROUP}
					disabled={disabled}
					onValueChange={(value) => {
						const { aggregate: _, ...rest } = draft;
						onChange(
							value === EACH_GROUP
								? rest
								: { ...draft, aggregate: value as Combine },
						);
					}}
				>
					<SelectTrigger aria-label={m.insight_aggregate()} className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper" align="start">
						<SelectItem value={EACH_GROUP}>
							{m.insight_aggregate_none()}
						</SelectItem>
						{COMBINE_GROUPS.map((group) => (
							<SelectGroup key={group.values[0]}>
								<SelectLabel>{group.label()}</SelectLabel>
								{group.values.map((value) => (
									<SelectItem key={value} value={value}>
										{AGGREGATE_LABEL[value]()}
									</SelectItem>
								))}
							</SelectGroup>
						))}
					</SelectContent>
				</Select>
			)}
			{/* One combined line needs no limit or Other. */}
			{draft.groupBy &&
				(!draft.aggregate || draft.display.type === "heatmap") && (
					<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
						<div className="flex items-center gap-2">
							<Label htmlFor={`${id}-limit`} className="text-xs font-normal">
								{m.insight_limit()}
							</Label>
							<Input
								id={`${id}-limit`}
								type="number"
								min={1}
								max={MAX_SERIES}
								value={draft.limit}
								disabled={disabled}
								className="h-7 w-16 text-xs"
								onChange={(event) =>
									onChange({
										...draft,
										limit: Math.min(
											Math.max(Math.round(Number(event.target.value)) || 1, 1),
											MAX_SERIES,
										),
									})
								}
							/>
						</div>
						{draft.display.type !== "heatmap" && (
							<div className="flex items-center gap-2">
								<Label htmlFor={`${id}-other`} className="text-xs font-normal">
									{m.insight_other_group()}
								</Label>
								<Switch
									id={`${id}-other`}
									size="sm"
									checked={draft.other}
									disabled={disabled}
									onCheckedChange={(other) => onChange({ ...draft, other })}
								/>
							</div>
						)}
					</div>
				)}
		</>
	);
}
