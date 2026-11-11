import { m } from "@recount/i18n/messages";
import { UploadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";

/**
 * An organization or project avatar beside its name form, top-aligned with the input; the
 * form hides its visible label because the section already names it. Logo uploads are not
 * available yet.
 */
export function EntityIdentityRow({
	avatar,
	children,
}: {
	avatar: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex max-w-2xl items-start gap-4">
			<div className="flex shrink-0 flex-col items-center gap-1">
				{avatar}
				<Button type="button" variant="ghost" size="xs" disabled>
					<UploadIcon aria-hidden="true" />
					{m.settings_logo_upload()}
				</Button>
			</div>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}
