import { m } from "@recount/i18n/messages";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../ui/badge";

/** One compact line for a setting that is planned but cannot be used yet. */
export function ComingSoonNotice({
	id,
	children,
	ticket,
}: {
	id?: string;
	children: ReactNode;
	ticket?: { name: string; url: string };
}) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
			<Badge variant="secondary">{m.settings_coming_soon()}</Badge>
			<span id={id} className="text-muted-foreground">
				{children}
			</span>
			{ticket && (
				<a
					className="inline-flex items-center gap-1 underline underline-offset-4"
					href={ticket.url}
					target="_blank"
					rel="noopener noreferrer"
				>
					{m.settings_view_ticket({ ticket: ticket.name })}
					<ExternalLinkIcon aria-hidden="true" className="size-3.5" />
				</a>
			)}
		</div>
	);
}
