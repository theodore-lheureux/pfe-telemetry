import { m } from "@recount/i18n/messages";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";

/** A panel header with a title and a button that closes the whole picker. */
export function PanelHeader({
	title,
	onClose,
}: {
	title: string;
	onClose: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
			<h2 className="text-sm font-semibold">{title}</h2>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={m.range_close()}
				onClick={onClose}
			>
				<XIcon aria-hidden="true" />
			</Button>
		</div>
	);
}

/** Cancel returns to the preset menu; Apply submits the panel's form. */
export function PanelFooter({
	onCancel,
	disabled,
	summary,
	children,
}: {
	onCancel: () => void;
	disabled: boolean;
	summary?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
			<div>{children}</div>
			<div className="flex flex-wrap items-center justify-end gap-2">
				{summary && (
					<p className="text-sm text-muted-foreground" aria-live="polite">
						{summary}
					</p>
				)}
				<Button type="button" variant="outline" onClick={onCancel}>
					{m.cancel()}
				</Button>
				<Button type="submit" disabled={disabled}>
					{m.range_apply()}
				</Button>
			</div>
		</div>
	);
}
