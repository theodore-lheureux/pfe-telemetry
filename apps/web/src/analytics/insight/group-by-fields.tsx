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
import { attributeField } from "../fields";
import { attributeLabel } from "../metric-names";
import type { InsightDraft } from "./draft";
import { AGGREGATE_LABEL, COMBINE_GROUPS } from "./labels";

// Radix Select cannot use an empty value, so "no grouping" and "each group" have sentinels.
const NO_GROUP = "-";
const EACH_GROUP = "-";
const CORE_GROUPS = ["node", "host", "resource.id"];

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
	const byScope = (scope: "point" | "resource") =>
		(attributes ?? []).filter((attribute) => attribute.scope === scope);
	// A saved grouping stays selectable before attributes load.
	const listed = new Set([
		...CORE_GROUPS,
		...(attributes ?? []).map((attribute) =>
			attributeField(attribute.scope, attribute.key),
		),
	]);
	const unlisted =
		draft.groupBy && !listed.has(draft.groupBy) ? draft.groupBy : undefined;
	return (
		<>
			<Select
				value={draft.groupBy ?? NO_GROUP}
				disabled={disabled}
				onOpenChange={(open) => open && onOpen()}
				onValueChange={(value) =>
					onChange({
						...draft,
						groupBy: value === NO_GROUP ? undefined : value,
					})
				}
			>
				<SelectTrigger aria-label={m.insight_group_by()} className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent position="popper" align="start">
					<SelectItem value={NO_GROUP}>{m.insight_group_none()}</SelectItem>
					<SelectItem value="node">{m.insight_group_node()}</SelectItem>
					<SelectItem value="host">{m.insight_group_host()}</SelectItem>
					<SelectItem value="resource.id">
						{m.insight_group_resource()}
					</SelectItem>
					{(["point", "resource"] as const).map(
						(scope) =>
							byScope(scope).length > 0 && (
								<SelectGroup key={scope}>
									<SelectLabel>
										{scope === "point"
											? m.insight_group_attributes()
											: m.insight_group_resource_attributes()}
									</SelectLabel>
									{byScope(scope).map((attribute) => (
										<SelectItem
											key={`${scope}/${attribute.key}`}
											value={attributeField(scope, attribute.key)}
										>
											{attributeLabel(attribute.key)}
										</SelectItem>
									))}
								</SelectGroup>
							),
					)}
					{unlisted && <SelectItem value={unlisted}>{unlisted}</SelectItem>}
				</SelectContent>
			</Select>
			{draft.groupBy && (
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
			{draft.groupBy && !draft.aggregate && (
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
				</div>
			)}
		</>
	);
}
