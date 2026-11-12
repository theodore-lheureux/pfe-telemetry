import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { StickyHeader } from "./sticky-header";

/** Classes for a tab link in a `PageHeader`'s tab bar. */
export function pageTabClass(active: boolean) {
	return cn(
		"-mb-px inline-flex items-center gap-2 border-b-2 pb-2.5 text-sm transition-colors",
		active
			? "border-primary text-primary"
			: "border-transparent text-muted-foreground hover:text-foreground",
	);
}

/** A page title that stays pinned, with a description and a tab bar of typed links. */
export function PageHeader({
	icon: Icon,
	title,
	description,
	tabs,
	heading,
}: {
	icon: LucideIcon;
	/** Names the page, and its tab bar for assistive technology. */
	title: string;
	description: ReactNode;
	/** Tab links styled with `pageTabClass`. */
	tabs: ReactNode;
	/** Replaces the pinned title, such as an editable name; it provides its own `h1`. */
	heading?: ReactNode;
}) {
	return (
		<>
			<StickyHeader>
				{heading ?? (
					<h1 className="flex items-center gap-2 text-xl font-semibold">
						<Icon aria-hidden="true" className="size-5" />
						{title}
					</h1>
				)}
			</StickyHeader>
			{/* Only the title stays pinned. The header's bottom padding covers 12px below the
			    title, so the description can move up at most 8px without being hidden. */}
			<div className="-mt-2 flex flex-col gap-5">
				{typeof description === "string" ? (
					<p className="text-sm text-muted-foreground">{description}</p>
				) : (
					description
				)}
				<nav aria-label={title} className="flex gap-6 border-b">
					{tabs}
				</nav>
			</div>
		</>
	);
}
