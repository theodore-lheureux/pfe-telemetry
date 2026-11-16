import { m } from "@recount/i18n/messages";
import { type FormEvent, useId } from "react";
import { GroupByPicker } from "../analytics/group-by-picker";
import type { InsightPerson } from "../analytics/saved-insights";
import { FormFeedback } from "../components/form-feedback";
import { Label } from "../components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "../components/ui/native-select";
import type { AnnotationInput, AttributeEntry, MetricEntry } from "./contracts";
import { AnnotationFields } from "./definition-parts";
import { defaultDescription } from "./metric-columns";

export type MetricDraft = AnnotationInput & {
	ownerId: string | null;
	defaultBreakdown: string | null;
};

export function metricDraft(metric: MetricEntry): MetricDraft {
	return {
		description: metric.description,
		tags: metric.tags,
		status: metric.status,
		ownerId: metric.owner?.id ?? null,
		defaultBreakdown: metric.defaultBreakdown,
	};
}

const NONE = "";
// Not a field, so it cannot collide with a real breakdown.
const NO_BREAKDOWN = "-";

/** What members add to a metric, submitted by the page's Save button through `id`. */
export function MetricForm({
	id,
	metric,
	draft,
	people,
	attributes,
	disabled,
	feedback,
	onChange,
	onSubmit,
}: {
	id: string;
	metric: MetricEntry;
	draft: MetricDraft;
	people: InsightPerson[];
	attributes: AttributeEntry[];
	disabled: boolean;
	feedback: { message: string; kind: "success" | "warning" | "error" };
	onChange: (draft: MetricDraft) => void;
	onSubmit: () => void;
}) {
	const field = useId();
	const submit = (event: FormEvent) => {
		event.preventDefault();
		onSubmit();
	};
	return (
		<form id={id} className="flex max-w-3xl flex-col gap-5" onSubmit={submit}>
			<AnnotationFields
				value={draft}
				kind="metric"
				placeholder={
					defaultDescription(metric) || m.definitions_description_placeholder()
				}
				disabled={disabled}
				onChange={(value) => onChange({ ...draft, ...value })}
			>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${field}-owner`}>{m.definitions_owner()}</Label>
					<NativeSelect
						id={`${field}-owner`}
						value={draft.ownerId ?? NONE}
						disabled={disabled}
						className="w-full sm:w-72"
						onChange={(event) =>
							onChange({ ...draft, ownerId: event.target.value || null })
						}
					>
						<NativeSelectOption value={NONE}>
							{m.definitions_no_owner()}
						</NativeSelectOption>
						{people.map((person) => (
							<NativeSelectOption key={person.id} value={person.id}>
								{person.name || person.email}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			</AnnotationFields>
			<div className="flex flex-col gap-1.5">
				<span className="text-sm font-medium">
					{m.definitions_default_breakdown()}
				</span>
				<GroupByPicker
					value={draft.defaultBreakdown ?? NO_BREAKDOWN}
					label={m.definitions_default_breakdown()}
					choices={[{ value: NO_BREAKDOWN, label: m.definitions_none() }]}
					attributes={attributes.map(
						({ scope, key, kind, description, status }) => ({
							metric: metric.name,
							scope,
							key,
							kind,
							note: description,
							status: status ?? undefined,
						}),
					)}
					loading={false}
					disabled={disabled}
					className="w-full sm:w-80"
					onOpen={() => {}}
					onChange={(value) =>
						onChange({
							...draft,
							defaultBreakdown: value === NO_BREAKDOWN ? null : value,
						})
					}
				/>
				<p className="text-xs text-muted-foreground italic">
					{m.definitions_default_breakdown_hint()}
				</p>
			</div>
			<FormFeedback
				message={feedback.message}
				kind={feedback.kind}
				reserveLine={false}
			/>
		</form>
	);
}
