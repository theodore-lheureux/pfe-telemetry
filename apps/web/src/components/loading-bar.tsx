import { cn } from "cn";

/** The moving segment of an indeterminate progress bar; the parent sets its track. */
export function ProgressStripe() {
	return (
		<div className="h-full w-1/3 animate-[navigation-progress_1.1s_ease-in-out_infinite] bg-primary motion-reduce:w-full motion-reduce:animate-none" />
	);
}

/** A thin progress bar along the top edge of a `relative` container while it reloads. */
export function LoadingBar({
	active,
	className,
}: {
	active: boolean;
	className?: string;
}) {
	if (!active) return null;
	return (
		<div
			aria-hidden="true"
			className={cn(
				"absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-primary/15",
				className,
			)}
		>
			<ProgressStripe />
		</div>
	);
}
