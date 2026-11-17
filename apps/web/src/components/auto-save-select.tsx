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
	/** Receives the select too, for returning focus after a confirmation. */
	onSave: (
		value: Value,
		select: HTMLSelectElement,
	) => Promise<unknown> | undefined;
	className?: string;
}) {
	const hydrated = useHydrated();
	const [shown, show] = useOptimistic(value);
	const [saving, startSaving] = useTransition();
	return (
		<div className={cn("relative", className)}>
			<NativeSelect
				aria-label={label}
				aria-busy={saving}
				value={shown}
				// Stays enabled while saving so keyboard focus is not lost.
				disabled={disabled || !hydrated}
				// The spinner takes the chevron's place while saving.
				className={cn(
					"w-full min-w-36",
					saving && "[&_[data-slot=native-select-icon]]:invisible",
				)}
				onChange={(event) => {
					if (saving) return;
					const select = event.currentTarget;
					const next = select.value as Value;
					// A handler that opens a confirmation returns nothing; keep that out of the
					// transition, which would otherwise own the dialog it opens.
					const save = onSave(next, select);
					if (!save) return;
					startSaving(async () => {
						show(next);
						await save;
					});
				}}
			>
				{options.map((option) => (
					<NativeSelectOption key={option.value} value={option.value}>
						{option.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
			{saving && (
				<Spinner
					aria-label={m.saving()}
					className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"
				/>
			)}
		</div>
	);
}
