import { m } from "@recount/i18n/messages";
import { LoaderCircleIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "../../components/ui/native-select";
import { Switch } from "../../components/ui/switch";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../../components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { isCalculatedMetric } from "../calculated-metrics";
import type { Spread } from "../contracts";
import {
	type Display,
	type DisplayType,
	type DisplayUnit,
	type InsightDraft,
	type LegendPosition,
	MAX_AXIS_LABEL,
	MAX_MOVING_AVERAGE,
	MAX_UNIT_AFFIX,
} from "./draft";
import { CUSTOM_UNITS, FORMAT_UNITS, UNIT_LABEL } from "./labels";
import { NumberDisplayOptions } from "./number-display-options";
import { chartPolicy } from "./panels/chart-policy";
import { chartLabel, chartTypes } from "./panels/registry";

const SECTION =
	"text-xs font-medium tracking-wide text-muted-foreground uppercase";

/** A setting's label and control on one line. */
function Row({
	id,
	label,
	children,
}: {
	id: string;
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<Label htmlFor={id} className="font-normal">
				{label}
			</Label>
			{children}
		</div>
	);
}

/** Text typed freely and applied when the field is left or Enter is pressed. */
function CommitInput({
	id,
	value,
	placeholder,
	type = "text",
	disabled,
	className,
	parse,
	onCommit,
	"aria-label": ariaLabel,
}: {
	id: string;
	/** Names a field that has no visible label. */
	"aria-label"?: string;
	value: string;
	placeholder: string;
	type?: "text" | "number";
	disabled: boolean;
	className?: string;
	/** The value to apply, or null to restore the field. */
	parse: (text: string) => { value: string | number | undefined } | null;
	onCommit: (value: string | number | undefined) => void;
}) {
	const [text, setText] = useState(value);
	const [shown, setShown] = useState(value);
	// A change made elsewhere, such as another tab saving, replaces the text.
	if (shown !== value) {
		setShown(value);
		setText(value);
	}
	const commit = () => {
		const parsed = parse(text.trim());
		if (!parsed) return setText(value);
		if (String(parsed.value ?? "") !== value) onCommit(parsed.value);
	};
	return (
		<Input
			id={id}
			aria-label={ariaLabel}
			type={type}
			value={text}
			placeholder={placeholder}
			disabled={disabled}
			className={className}
			onChange={(event) => setText(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") commit();
			}}
		/>
	);
}

/**
 * Why an insight's lines can have no range across sources, or null when some can.
 * Formulas combine finished values, and a sum or count is larger than each source.
 */
export function spreadUnavailable(draft: InsightDraft): string | null {
	if (
		draft.series.some(
			(series) => series.metric && isCalculatedMetric(series.metric),
		)
	)
		return m.display_spread_formula();
	// A collapsed breakdown bands across its groups, which formulas and sums have too.
	if (draft.groupBy && draft.aggregate) return null;
	if (draft.formulas.some((formula) => formula.expression.trim()))
		return m.display_spread_formula();
	if (
		draft.series.every(
			(series) => series.combine === "sum" || series.combine === "count",
		)
	)
		return m.display_spread_sum();
	return null;
}

const label = (text: string) =>
	text.length <= MAX_AXIS_LABEL ? { value: text || undefined } : null;
const affix = (text: string) =>
	text.length <= MAX_UNIT_AFFIX ? { value: text || undefined } : null;
const number = (text: string) => {
	if (!text) return { value: undefined };
	const value = Number(text);
	return Number.isFinite(value) ? { value } : null;
};

function AxisBounds({
	id,
	display,
	disabled,
	onCommit,
}: {
	id: string;
	display: Display;
	disabled: boolean;
	onCommit: (key: "yMin" | "yMax", value: number | undefined) => void;
}) {
	const keys = chartPolicy(display.type).bucketCounts
		? (["yMin", "yMax"] as const)
		: (["yMax"] as const);
	return keys.map((key) => (
		<Row
			key={key}
			id={`${id}-${key}`}
			label={key === "yMin" ? m.display_y_min() : m.display_y_max()}
		>
			<CommitInput
				id={`${id}-${key}`}
				type="number"
				value={String(display[key] ?? "")}
				placeholder={m.display_auto()}
				disabled={disabled}
				className="w-28"
				parse={number}
				onCommit={(value) => onCommit(key, value as number | undefined)}
			/>
		</Row>
	));
}

/**
 * How an insight's chart looks: its type, then general, axis and line settings for
 * charts over time. Shared by the insight editor and a dashboard tile's menu.
 */
export function DisplayOptions({
	display,
	disabled,
	showType = true,
	saving = false,
	spreadBlocked = null,
	onChange,
}: {
	display: Display;
	disabled: boolean;
	/** The editor picks the chart type in its toolbar instead. */
	showType?: boolean;
	saving?: boolean;
	/** Why the range across sources cannot apply, from `spreadUnavailable`. */
	spreadBlocked?: string | null;
	onChange: (display: Display) => void;
}) {
	const id = useId();
	const set = <K extends keyof Display>(
		key: K,
		value: Display[K] | undefined,
	) => {
		const { [key]: _, ...rest } = display;
		onChange(
			value === undefined ? (rest as Display) : { ...display, [key]: value },
		);
	};
	const {
		showAxes: overTime,
		showLines: lines,
		reducesSeries,
	} = chartPolicy(display.type);
	return (
		// Typing in a menu would otherwise jump to the item starting with that letter.
		<fieldset
			aria-label={m.display_options()}
			className="m-0 flex w-72 min-w-0 flex-col gap-3 border-0 p-0"
			onKeyDown={(event) => event.stopPropagation()}
		>
			{(showType || saving) && (
				<div className="flex items-center justify-between gap-2">
					{showType && (
						<Label htmlFor={`${id}-type`} className={SECTION}>
							{m.display_chart_type()}
						</Label>
					)}
					{saving && (
						<span
							className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"
							role="status"
						>
							<LoaderCircleIcon
								aria-hidden="true"
								className="size-3 motion-safe:animate-spin"
							/>
							{m.display_saving()}
						</span>
					)}
				</div>
			)}
			{showType && (
				<NativeSelect
					id={`${id}-type`}
					value={display.type}
					disabled={disabled}
					className="w-full"
					onChange={(event) => set("type", event.target.value as DisplayType)}
				>
					{chartTypes.map((type) => (
						<NativeSelectOption key={type} value={type}>
							{chartLabel(type)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			)}
			<Tabs defaultValue="general">
				<TabsList className="w-full">
					<TabsTrigger value="general">{m.display_general()}</TabsTrigger>
					{overTime && (
						<TabsTrigger value="axes">{m.display_axes()}</TabsTrigger>
					)}
					{lines && (
						<TabsTrigger value="lines">{m.display_lines()}</TabsTrigger>
					)}
				</TabsList>
				<TabsContent value="general" className="flex flex-col gap-3 pt-2">
					{reducesSeries && (
						<NumberDisplayOptions
							display={display}
							disabled={disabled}
							onChange={onChange}
						/>
					)}
					{lines && (
						<>
							<Row id={`${id}-values`} label={m.display_show_values()}>
								<Switch
									id={`${id}-values`}
									checked={!!display.showValues}
									disabled={disabled}
									onCheckedChange={(on) => set("showValues", on || undefined)}
								/>
							</Row>
							<Row id={`${id}-legend`} label={m.display_show_legend()}>
								<Switch
									id={`${id}-legend`}
									checked={display.legend !== undefined}
									disabled={disabled}
									onCheckedChange={(on) =>
										set("legend", on ? "bottom" : undefined)
									}
								/>
							</Row>
							{display.legend && (
								<Row id={`${id}-position`} label={m.display_legend_position()}>
									<NativeSelect
										id={`${id}-position`}
										value={display.legend}
										disabled={disabled}
										onChange={(event) =>
											set("legend", event.target.value as LegendPosition)
										}
									>
										<NativeSelectOption value="bottom">
											{m.display_legend_bottom()}
										</NativeSelectOption>
										<NativeSelectOption value="right">
											{m.display_legend_right()}
										</NativeSelectOption>
									</NativeSelect>
								</Row>
							)}
						</>
					)}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-unit`} className={SECTION}>
							{m.insight_unit()}
						</Label>
						<NativeSelect
							id={`${id}-unit`}
							value={display.unit}
							disabled={disabled}
							className="w-full"
							onChange={(event) => {
								const unit = event.target.value as DisplayUnit;
								const { unitAffix, ...rest } = display;
								onChange(
									CUSTOM_UNITS.includes(unit)
										? { ...display, unit }
										: { ...rest, unit },
								);
							}}
						>
							{FORMAT_UNITS.map((unit) => (
								<NativeSelectOption key={unit} value={unit}>
									{UNIT_LABEL[unit]()}
								</NativeSelectOption>
							))}
							<hr />
							{CUSTOM_UNITS.map((unit) => (
								<NativeSelectOption key={unit} value={unit}>
									{UNIT_LABEL[unit]()}
								</NativeSelectOption>
							))}
						</NativeSelect>
						{CUSTOM_UNITS.includes(display.unit) && (
							<CommitInput
								id={`${id}-unit-affix`}
								aria-label={UNIT_LABEL[display.unit]()}
								value={display.unitAffix ?? ""}
								placeholder={m.insight_unit_affix_placeholder()}
								disabled={disabled}
								parse={affix}
								onCommit={(value) =>
									set("unitAffix", value as string | undefined)
								}
							/>
						)}
					</div>
				</TabsContent>
				{overTime && (
					<TabsContent value="axes" className="flex flex-col gap-3 pt-2">
						<p className={SECTION}>{m.display_x_axis()}</p>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`${id}-x`} className="font-normal">
								{m.display_axis_label()}
							</Label>
							<CommitInput
								id={`${id}-x`}
								value={display.xLabel ?? ""}
								placeholder={m.display_none()}
								disabled={disabled}
								parse={label}
								onCommit={(value) => set("xLabel", value as string | undefined)}
							/>
						</div>
						<p className={SECTION}>{m.display_y_axis()}</p>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`${id}-y`} className="font-normal">
								{m.display_axis_label()}
							</Label>
							<CommitInput
								id={`${id}-y`}
								value={display.yLabel ?? ""}
								placeholder={m.display_none()}
								disabled={disabled}
								parse={label}
								onCommit={(value) => set("yLabel", value as string | undefined)}
							/>
						</div>
						<AxisBounds
							id={id}
							display={display}
							disabled={disabled}
							onCommit={set}
						/>
						{lines && (
							<Row id={`${id}-goal`} label={m.insight_goal()}>
								<CommitInput
									id={`${id}-goal`}
									type="number"
									value={display.goal === undefined ? "" : String(display.goal)}
									placeholder={m.insight_goal_none()}
									disabled={disabled}
									className="w-28"
									parse={number}
									onCommit={(value) => set("goal", value as number | undefined)}
								/>
							</Row>
						)}
						<Row id={`${id}-zero`} label={m.insight_begin_at_zero()}>
							<Switch
								id={`${id}-zero`}
								checked={display.beginAtZero}
								disabled={disabled || display.logScale}
								onCheckedChange={(beginAtZero) =>
									set("beginAtZero", beginAtZero)
								}
							/>
						</Row>
						{lines && (
							<ToggleGroup
								type="single"
								variant="outline"
								aria-label={m.display_scale()}
								value={display.logScale ? "log" : "linear"}
								disabled={disabled}
								className="w-full"
								onValueChange={(value) =>
									value && set("logScale", value === "log")
								}
							>
								<ToggleGroupItem value="linear" className="flex-1">
									{m.display_scale_linear()}
								</ToggleGroupItem>
								<ToggleGroupItem value="log" className="flex-1">
									{m.display_scale_log()}
								</ToggleGroupItem>
							</ToggleGroup>
						)}
					</TabsContent>
				)}
				{lines && (
					<TabsContent value="lines" className="flex flex-col gap-3 pt-2">
						<p className={SECTION}>{m.display_style()}</p>
						<ToggleGroup
							type="single"
							variant="outline"
							aria-label={m.display_style()}
							value={display.lineStyle ?? "straight"}
							disabled={disabled}
							className="w-full"
							onValueChange={(value) =>
								value &&
								set("lineStyle", value === "smooth" ? "smooth" : undefined)
							}
						>
							<ToggleGroupItem value="smooth" className="flex-1">
								{m.display_smooth()}
							</ToggleGroupItem>
							<ToggleGroupItem value="straight" className="flex-1">
								{m.display_straight()}
							</ToggleGroupItem>
						</ToggleGroup>
						<p className={SECTION}>{m.display_overlays()}</p>
						<Row id={`${id}-trend`} label={m.display_trend()}>
							<Switch
								id={`${id}-trend`}
								checked={!!display.trend}
								disabled={disabled}
								onCheckedChange={(on) => set("trend", on || undefined)}
							/>
						</Row>
						<Row id={`${id}-average`} label={m.display_moving_average()}>
							<Switch
								id={`${id}-average`}
								checked={display.movingAverage !== undefined}
								disabled={disabled}
								onCheckedChange={(on) =>
									set("movingAverage", on ? 7 : undefined)
								}
							/>
						</Row>
						{display.movingAverage !== undefined && (
							<Row
								id={`${id}-window`}
								label={m.display_moving_average_window()}
							>
								<CommitInput
									id={`${id}-window`}
									type="number"
									value={String(display.movingAverage)}
									placeholder="7"
									disabled={disabled}
									className="w-28"
									parse={(text) => {
										const value = Number(text);
										return Number.isInteger(value) &&
											value >= 2 &&
											value <= MAX_MOVING_AVERAGE
											? { value }
											: null;
									}}
									onCommit={(value) =>
										set("movingAverage", value as number | undefined)
									}
								/>
							</Row>
						)}
						<div className="flex flex-col gap-1">
							<Row id={`${id}-spread`} label={m.display_spread()}>
								<Switch
									id={`${id}-spread`}
									checked={display.spread !== undefined}
									// Left on when it no longer applies, so it can still be turned off.
									disabled={
										disabled ||
										(!!spreadBlocked && display.spread === undefined)
									}
									aria-describedby={`${id}-spread-hint`}
									onCheckedChange={(on) =>
										set("spread", on ? "range" : undefined)
									}
								/>
							</Row>
							<p
								id={`${id}-spread-hint`}
								className="text-xs text-muted-foreground"
							>
								{spreadBlocked ?? m.display_spread_hint()}
							</p>
						</div>
						{display.spread && (
							<ToggleGroup
								type="single"
								variant="outline"
								aria-label={m.display_spread_kind()}
								value={display.spread}
								disabled={disabled}
								className="w-full"
								onValueChange={(value) =>
									value && set("spread", value as Spread)
								}
							>
								<ToggleGroupItem value="range" className="flex-1">
									{m.display_spread_range()}
								</ToggleGroupItem>
								<ToggleGroupItem value="middle" className="flex-1">
									{m.display_spread_middle()}
								</ToggleGroupItem>
							</ToggleGroup>
						)}
					</TabsContent>
				)}
			</Tabs>
		</fieldset>
	);
}
