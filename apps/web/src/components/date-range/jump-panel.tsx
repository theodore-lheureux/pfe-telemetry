import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { type FormEvent, useId, useState } from "react";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";
import {
	type DateRange,
	JUMP_WINDOWS,
	type JumpAnchor,
	parseTimestamp,
} from "./date-range";
import { PanelFooter, PanelHeader } from "./picker-panel";

const ANCHOR_LABEL: Record<JumpAnchor, () => string> = {
	around: m.range_around,
	before: m.range_before,
	after: m.range_after,
};

/** A window of a few minutes around, before or after a pasted timestamp. */
export function JumpPanel({
	value,
	onApply,
	onCancel,
	onClose,
}: {
	value: DateRange;
	onApply: (value: DateRange) => void;
	onCancel: () => void;
	onClose: () => void;
}) {
	const id = useId();
	const locale = getLocale();
	const [timestamp, setTimestamp] = useState(
			value.kind === "jump" ? value.at.toISOString() : "",
		),
		[minutes, setMinutes] = useState<number>(
			value.kind === "jump" ? value.minutes : 5,
		),
		[anchor, setAnchor] = useState<JumpAnchor>(
			value.kind === "jump" ? value.anchor : "around",
		),
		[invalid, setInvalid] = useState(false);
	const submitJump = (event: FormEvent) => {
		event.preventDefault();
		const at = parseTimestamp(timestamp);
		if (!at || at.getTime() > Date.now()) {
			setInvalid(true);
			return;
		}
		onApply({ kind: "jump", at, minutes, anchor });
	};
	return (
		<form onSubmit={submitJump} className="flex flex-col">
			<PanelHeader title={m.range_jump_title()} onClose={onClose} />
			<div className="flex flex-col gap-3 p-4">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${id}-timestamp`}>{m.range_timestamp()}</Label>
					<Input
						id={`${id}-timestamp`}
						value={timestamp}
						autoComplete="off"
						spellCheck={false}
						placeholder={m.range_timestamp_placeholder()}
						aria-invalid={invalid || undefined}
						aria-describedby={invalid ? `${id}-timestamp-error` : undefined}
						onChange={(event) => {
							setTimestamp(event.target.value);
							setInvalid(false);
						}}
						className="font-mono"
					/>
					{invalid && (
						<p
							id={`${id}-timestamp-error`}
							className="text-xs text-destructive"
						>
							{m.range_timestamp_invalid()}
						</p>
					)}
				</div>
				<div className="flex items-center gap-2 text-sm">
					<Label htmlFor={`${id}-window`}>{m.range_window()}</Label>
					<NativeSelect
						id={`${id}-window`}
						value={String(minutes)}
						onChange={(event) => setMinutes(Number(event.target.value))}
					>
						{JUMP_WINDOWS.map((option) => (
							<NativeSelectOption key={option} value={String(option)}>
								{new Intl.NumberFormat(locale, {
									style: "unit",
									unit: "minute",
									unitDisplay: "short",
								}).format(option)}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<Label htmlFor={`${id}-anchor`} className="sr-only">
						{m.range_anchor()}
					</Label>
					<NativeSelect
						id={`${id}-anchor`}
						value={anchor}
						onChange={(event) => setAnchor(event.target.value as JumpAnchor)}
					>
						{(["around", "before", "after"] as const).map((option) => (
							<NativeSelectOption key={option} value={option}>
								{ANCHOR_LABEL[option]()}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			</div>
			<PanelFooter onCancel={onCancel} disabled={!timestamp.trim()} />
		</form>
	);
}
