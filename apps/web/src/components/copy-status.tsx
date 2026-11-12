import { m } from "@recount/i18n/messages";
import { cn } from "cn";

export type CopyState = "copied" | "failed" | null;

/** The copy state from separate flags; a failure wins over an earlier success. */
export function copyState(copied: unknown, failed: boolean): CopyState {
	if (failed) return "failed";
	if (copied) return "copied";
	return null;
}

function copyMessage(state: CopyState) {
	if (state === "failed") return m.settings_copy_failed();
	if (state === "copied") return m.settings_copied();
	return "";
}

/**
 * Announces a clipboard copy. Success is only announced; a failure is also shown, with
 * `className` placing it.
 */
export function CopyStatus({
	state,
	className,
}: {
	state: CopyState;
	className?: string;
}) {
	return (
		<p
			role="status"
			className={
				state === "failed"
					? cn("text-xs text-destructive", className)
					: "sr-only"
			}
		>
			{copyMessage(state)}
		</p>
	);
}
