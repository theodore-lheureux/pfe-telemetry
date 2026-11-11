import { m } from "@recount/i18n/messages";
import { HistoryIcon, Loader2Icon } from "lucide-react";
import { Button } from "../components/ui/button";

/** What an empty list means: waiting for live packets, or no stored points to show. */
export function ActivityEmpty({
	mode,
	filtered,
	onSearchFurther,
	disabled,
}: {
	mode: "explorer" | "live";
	filtered: boolean;
	/** Present when older points remain beyond the searched part of the range. */
	onSearchFurther?: () => void;
	disabled: boolean;
}) {
	const Icon = mode === "live" ? Loader2Icon : HistoryIcon;
	return (
		// Tide sets cell block padding, so spacing lives on this wrapper.
		<div className="px-6 py-12 text-center">
			<Icon
				aria-hidden="true"
				className={
					mode === "live"
						? "mx-auto mb-3 size-7 text-muted-foreground motion-safe:animate-spin"
						: "mx-auto mb-3 size-7 text-muted-foreground"
				}
			/>
			<p className="text-base font-semibold">
				{mode === "live"
					? `${m.activity_empty_live()}…`
					: filtered
						? m.activity_empty_filtered()
						: m.activity_empty_explorer()}
			</p>
			<p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
				{mode === "live"
					? m.activity_empty_live_note()
					: filtered
						? m.activity_empty_filtered_note()
						: m.activity_empty_explorer_note()}
			</p>
			{onSearchFurther && (
				<Button
					variant="outline"
					className="mt-3"
					disabled={disabled}
					onClick={onSearchFurther}
				>
					{m.activity_search_further()}
				</Button>
			)}
		</div>
	);
}
