import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { cn } from "cn";
import { useOptimistic, useTransition } from "react";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Spinner } from "./ui/spinner";

export type AutoSaveOption<Value extends string> = {
	value: Value;
	label: string;
};

/**
 * A select that saves as soon as it changes. It shows the new value while
 * `onSave` runs and returns to `value` afterwards, so a failed or declined save
 * reverts by itself; confirmations and errors are reported by the caller.
 */
export function AutoSaveSelect<Value extends string>({
	value,
	options,
	label,
	disabled = false,
	onSave,
	className,
}: {
	value: Value;
	options: AutoSaveOption<Value>[];
	label: string;
	disabled?: boolean;
	onSave: (value: Value) => Promise<unknown> | undefined;
	className?: string;
}) {
	const hydrated = useHydrated();
	const [shown, show] = useOptimistic(value);
	const [saving, startSaving] = useTransition();
	return (
		<div className={cn("flex items-center gap-2", className)}>
			<NativeSelect
				aria-label={label}
				aria-busy={saving}
				value={shown}
				// Stays enabled while saving so keyboard focus is not lost.
				disabled={disabled || !hydrated}
				className="min-w-36 flex-1"
				onChange={(event) => {
					if (saving) return;
					const next = event.target.value as Value;
					startSaving(async () => {
						show(next);
						await onSave(next);
					});
				}}
			>
				{options.map((option) => (
					<NativeSelectOption key={option.value} value={option.value}>
						{option.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<span className="flex size-4 shrink-0">
				{saving && <Spinner aria-label={m.saving()} />}
			</span>
		</div>
	);
}
