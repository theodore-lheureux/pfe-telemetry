import { m } from "@recount/i18n/messages";
import { useEffect, useId, useState } from "react";
import {
	DEFAULT_RANGE,
	parseSerializedRange,
	serializeRange,
} from "../../components/date-range/date-range";
import { DateRangePicker } from "../../components/date-range/date-range-picker";
import { DialogActions } from "../../components/dialog-actions";
import { FormFeedback } from "../../components/form-feedback";
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog";
import { Label } from "../../components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import type { ProjectReference } from "../../organizations/contracts";
import { AttributeFilter } from "../attribute-filter";
import { useMetricAttributes } from "../catalog";
import { INTERVALS, type Interval } from "../contracts";
import type { TileOverrides } from "../dashboard-filters";
import { FilterChips, withFilter } from "../filter-chips";
import { GroupByPicker } from "../group-by-picker";
import { MAX_RANGE_DAYS } from "../insight/draft";
import { COMPARISONS, comparisonKey } from "../insight/insight-toolbar";
import { INTERVAL_LABEL } from "../insight/labels";

// Radix Select cannot use an empty value, so "inherit" and "none" have sentinels.
const INHERIT = "-inherit";
const NONE = "-none";

function Section({ title }: { title: string }) {
	return (
		<p className="border-b pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
			{title}
		</p>
	);
}

/**
 * One tile's own overrides: whether it ignores the dashboard's, and its range,
 * interval, filters, breakdown and comparison. Each control's first choice inherits.
 */
export function TileOverridesDialog({
	open,
	name,
	initial,
	userId,
	reference,
	pending,
	error,
	onClose,
	onSave,
}: {
	open: boolean;
	name: string;
	initial: TileOverrides;
	userId: string;
	reference: ProjectReference;
	pending: boolean;
	error: string;
	onClose: () => void;
	onSave: (overrides: TileOverrides) => void;
}) {
	const id = useId();
	const [overrides, setOverrides] = useState(initial);
	useEffect(() => {
		if (open) setOverrides(initial);
	}, [open, initial]);
	const [wantsAttributes, setWantsAttributes] = useState(false);
	const attributes = useMetricAttributes(
		userId,
		reference,
		undefined,
		wantsAttributes,
	);
	const set = <K extends keyof TileOverrides>(
		key: K,
		value: TileOverrides[K] | undefined,
	) =>
		setOverrides((current) => {
			const { [key]: _, ...rest } = current;
			return value === undefined ? rest : { ...rest, [key]: value };
		});
	const range = overrides.range && parseSerializedRange(overrides.range);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !pending) onClose();
			}}
		>
			<DialogContent
				className="max-h-[calc(100svh-4rem)] overflow-y-auto sm:max-w-xl"
				showCloseButton={!pending}
			>
				<form
					method="post"
					className="flex flex-col gap-5"
					onSubmit={(event) => {
						event.preventDefault();
						onSave(overrides);
					}}
				>
					<DialogHeader>
						<DialogTitle>{m.tile_overrides_title({ name })}</DialogTitle>
						<DialogDescription>
							{m.tile_overrides_description()}
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
							<Label htmlFor={`${id}-ignore`}>
								{m.tile_ignore_dashboard()}
							</Label>
							<Switch
								id={`${id}-ignore`}
								checked={!!overrides.ignoreDashboard}
								disabled={pending}
								onCheckedChange={(on) =>
									set("ignoreDashboard", on ? true : undefined)
								}
							/>
						</div>
						<p className="text-xs text-muted-foreground">
							{m.tile_ignore_dashboard_hint()}
						</p>
					</div>
					<Section title={m.dashboard_info_range()} />
					<div className="flex flex-wrap items-end gap-4">
						<DateRangePicker
							value={range || DEFAULT_RANGE}
							none={{
								label: m.tile_inherit(),
								selected: !range,
								onClear: () => set("range", undefined),
							}}
							disabled={pending}
							maxDays={MAX_RANGE_DAYS}
							onChange={(next) => set("range", serializeRange(next))}
						/>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`${id}-interval`}>{m.insight_interval()}</Label>
							<Select
								value={overrides.interval ?? INHERIT}
								disabled={pending}
								onValueChange={(value) =>
									set(
										"interval",
										value === INHERIT ? undefined : (value as Interval),
									)
								}
							>
								<SelectTrigger id={`${id}-interval`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper" align="start">
									<SelectItem value={INHERIT}>{m.tile_inherit()}</SelectItem>
									{(Object.keys(INTERVALS) as Interval[]).map((interval) => (
										<SelectItem key={interval} value={interval}>
											{INTERVAL_LABEL[interval]()}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<Section title={m.dashboard_info_filters()} />
					<div className="flex flex-wrap items-center gap-2">
						<FilterChips
							filters={overrides.filters ?? []}
							disabled={pending}
							onChange={(next) =>
								set("filters", next.length ? next : undefined)
							}
						/>
						<AttributeFilter
							attributes={attributes.data}
							loading={attributes.isFetching}
							values={{ userId, reference }}
							disabled={pending}
							label={m.dashboard_add_filter()}
							onOpen={() => setWantsAttributes(true)}
							onAdd={(filter) =>
								set("filters", withFilter(overrides.filters ?? [], filter))
							}
						/>
					</div>
					<Section title={m.tile_breakdown_section()} />
					<div className="flex flex-wrap items-end gap-4">
						<GroupByPicker
							value={
								overrides.breakdown === ""
									? NONE
									: (overrides.breakdown ?? INHERIT)
							}
							choices={[
								{ value: INHERIT, label: m.tile_inherit() },
								{ value: NONE, label: m.dashboard_no_breakdown() },
							]}
							attributes={attributes.data}
							loading={attributes.isFetching}
							disabled={pending}
							onOpen={() => setWantsAttributes(true)}
							onChange={(value) => {
								if (value === INHERIT) return set("breakdown", undefined);
								set("breakdown", value === NONE ? "" : value);
							}}
						/>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`${id}-compare`}>
								{m.dashboard_comparison()}
							</Label>
							<Select
								value={
									overrides.compare === undefined
										? INHERIT
										: comparisonKey(overrides.compare ?? undefined)
								}
								disabled={pending}
								onValueChange={(key) => {
									if (key === INHERIT) return set("compare", undefined);
									const option = COMPARISONS.find((entry) => entry.key === key);
									set("compare", option?.value ?? null);
								}}
							>
								<SelectTrigger id={`${id}-compare`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper" align="start">
									<SelectItem value={INHERIT}>{m.tile_inherit()}</SelectItem>
									{COMPARISONS.map((option) => (
										<SelectItem key={option.key} value={option.key}>
											{option.label()}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<Button
						type="button"
						variant="ghost"
						className="self-start"
						disabled={pending || Object.keys(overrides).length === 0}
						onClick={() => setOverrides({})}
					>
						{m.tile_clear_overrides()}
					</Button>
					<FormFeedback message={error} kind="error" reserveLine={false} />
					<DialogActions
						cancel={{ label: m.cancel(), disabled: pending, onClick: onClose }}
					>
						<Button
							type="submit"
							disabled={pending}
							pending={pending}
							pendingLabel={m.saving()}
						>
							{m.saved_save()}
						</Button>
					</DialogActions>
				</form>
			</DialogContent>
		</Dialog>
	);
}
