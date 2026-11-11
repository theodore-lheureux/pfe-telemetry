import { cn } from "cn";
import type { ReactNode, Ref } from "react";

// Sign-in, second-factor and invitation screens share one centred card so they read as
// steps of the same flow.
export function AuthCard({
	title,
	description,
	children,
	headingRef,
	headingId,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	children: ReactNode;
	headingRef?: Ref<HTMLHeadingElement>;
	/** Lets dialogs return focus to the heading after closing. */
	headingId?: string;
	className?: string;
}) {
	return (
		<main
			className={cn(
				"mx-auto my-8 flex w-[calc(100%-2rem)] max-w-md flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground shadow-xs sm:mt-[12vh]",
				className,
			)}
		>
			<div className="flex flex-col gap-1.5">
				<h1
					ref={headingRef}
					id={headingId}
					tabIndex={headingRef || headingId ? -1 : undefined}
					className="text-[22px] font-medium tracking-tight"
				>
					{title}
				</h1>
				{description && (
					<p className="text-sm text-muted-foreground">{description}</p>
				)}
			</div>
			{children}
		</main>
	);
}

/** A divider with a short label, such as "or" between two ways to sign in. */
export function AuthDivider({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-center gap-3 text-xs text-muted-foreground uppercase">
			<span className="h-px flex-1 bg-border" />
			{children}
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}
