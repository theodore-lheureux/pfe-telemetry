import { m } from "@recount/i18n/messages";
import { LinkIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";

export function SettingsSection({
	id,
	title,
	description,
	children,
	headingRef,
}: {
	id: string;
	title: string;
	description?: string;
	children: ReactNode;
	headingRef?: Ref<HTMLHeadingElement>;
}) {
	return (
		<section aria-labelledby={id} className="flex min-w-0 flex-col gap-4">
			<div>
				<div className="flex items-center gap-2">
					<h2
						ref={headingRef}
						tabIndex={headingRef ? -1 : undefined}
						id={id}
						className="scroll-mt-6 text-base font-semibold"
					>
						{title}
					</h2>
					<a
						href={`#${id}`}
						aria-label={m.settings_section_link({ section: title })}
						className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
					>
						<LinkIcon aria-hidden="true" className="size-3.5" />
					</a>
				</div>
				{description && (
					<p className="mt-1 text-sm text-muted-foreground">{description}</p>
				)}
			</div>
			{children}
		</section>
	);
}
