import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import {
	AppWindowIcon,
	CircleDotIcon,
	ServerIcon,
	UserIcon,
	XIcon,
} from "lucide-react";
import { FacetFilter } from "../analytics/saved/facet-filter";
import {
	type DateRange,
	DEFAULT_RANGE,
	resolveRange,
} from "../components/date-range/date-range";
import { DateRangePicker } from "../components/date-range/date-range-picker";
import { SearchField } from "../components/search-field";
import { useDisplayTimeZone } from "../components/time-display";
import { Button } from "../components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../components/ui/select";
import { cn } from "../lib/utils";
import {
	EXECUTION_STATES,
	type ExecutionFilterOptions,
	type ExecutionNode,
	type ExecutionState,
} from "./contracts";
import { nodeLabel, stateLabel } from "./labels";
import { type ExecutionSearch, hasExecutionFilters } from "./validation";

/** The period in the picker: absolute bounds, or where custom ranges start. */
function periodRange(search: ExecutionSearch): DateRange {
	if (search.to)
		return {
			kind: "between",
			from: new Date(search.from ?? 0),
			to: new Date(search.to),
		};
	if (search.from) return { kind: "since", from: new Date(search.from) };
	return DEFAULT_RANGE;
}

const byLabel = (a: { label: string }, b: { label: string }) =>
	a.label.localeCompare(b.label, getLocale());

/** Choices plus selected values missing from them, so a selection can be removed. */
function withSelected<T>(choices: T[] | undefined, selected: T[] = []) {
	const all = choices ?? [];
	return [...all, ...selected.filter((value) => !all.includes(value))];
}

/** Search, application, state, machine, owner and period filters kept in the URL. */
export function ExecutionFilterBar({
	search,
	options,
	text,
	disabled,
	onChange,
	onClear,
}: {
	search: ExecutionSearch;
	/** The search field, whose text reaches the URL once typing pauses. */
	text: { text: string; change: (value: string) => void };
	options: ExecutionFilterOptions | undefined;
	disabled: boolean;
	/** Changes some filters. */
	onChange: (patch: Partial<ExecutionSearch>) => void;
	onClear: () => void;
}) {
	const zone = useDisplayTimeZone();
	const many = <T,>(values: T[]) => (values.length ? values : undefined);
	const nodes = new Map<string, ExecutionNode>(
		(options?.machines ?? []).map((node) => [node.id, node]),
	);
	const machines = withSelected(
		options?.machines.map((node) => node.id),
		search.machine,
	)
		.map((id) => ({
			value: id,
			label: nodeLabel(nodes.get(id) ?? { id, hostname: null }),
		}))
		.sort(byLabel);
	const setPeriod = (range: DateRange) => {
		if (range.kind === "preset" && range.preset === "all_time")
			return onChange({ from: undefined, to: undefined });
		const { from, to } = resolveRange(range, new Date(), zone, getLocale());
		onChange({ from: from.toISOString(), to: to?.toISOString() });
	};
	return (
		<search className="flex flex-wrap items-center gap-2">
			<SearchField
				label={m.executions_search()}
				value={text.text}
				onChange={text.change}
			/>
			<FacetFilter
				label={m.executions_filter_application()}
				icon={<AppWindowIcon aria-hidden="true" />}
				searchable
				disabled={disabled}
				selected={search.application ?? []}
				options={withSelected(options?.applications, search.application)
					.map((name) => ({ value: name, label: name }))
					.sort(byLabel)}
				onChange={(values) => onChange({ application: many(values) })}
			/>
			<Select
				value={search.state ?? "all"}
				disabled={disabled}
				onValueChange={(value) =>
					onChange({
						state: value === "all" ? undefined : (value as ExecutionState),
					})
				}
			>
				<SelectTrigger
					aria-label={m.executions_filter_state()}
					// Matches the outline buttons around it rather than a form field.
					className={cn(
						"h-8 border-border bg-background font-medium hover:bg-muted dark:border-input",
						search.state && "border-primary/60",
					)}
				>
					<CircleDotIcon aria-hidden="true" />
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">{m.executions_state_all()}</SelectItem>
					{EXECUTION_STATES.map((state) => (
						<SelectItem key={state} value={state}>
							{stateLabel(state)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<FacetFilter
				label={m.executions_filter_machine()}
				icon={<ServerIcon aria-hidden="true" />}
				searchable
				disabled={disabled}
				selected={search.machine ?? []}
				options={machines}
				onChange={(values) => onChange({ machine: many(values) })}
			/>
			<FacetFilter
				label={m.executions_filter_owner()}
				icon={<UserIcon aria-hidden="true" />}
				searchable
				disabled={disabled}
				selected={(search.owner ?? []).map(String)}
				options={withSelected(options?.owners, search.owner).map((uid) => ({
					value: String(uid),
					label: String(uid),
				}))}
				onChange={(values) => onChange({ owner: many(values.map(Number)) })}
			/>
			<DateRangePicker
				value={periodRange(search)}
				disabled={disabled}
				none={{
					label: m.executions_filter_any_time(),
					selected: !search.from && !search.to,
					onClear: () => onChange({ from: undefined, to: undefined }),
				}}
				onChange={setPeriod}
			/>
			{hasExecutionFilters(search) && (
				<Button variant="ghost" disabled={disabled} onClick={onClear}>
					<XIcon aria-hidden="true" />
					{m.executions_clear_filters()}
				</Button>
			)}
		</search>
	);
}
