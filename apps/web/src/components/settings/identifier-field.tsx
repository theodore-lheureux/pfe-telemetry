import { m } from "@recount/i18n/messages";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";

export function IdentifierField({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	const [failed, setFailed] = useState(false);
	return (
		<div>
			<div className="flex min-w-0 items-center gap-2 rounded-md border bg-card px-3 py-1">
				<code className="min-w-0 flex-1 break-all text-sm select-all">
					{value}
				</code>
				<Button
					type="button"
					size="icon-sm"
					variant="ghost"
					aria-label={m.settings_copy()}
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(value);
							setCopied(true);
							setFailed(false);
						} catch {
							setFailed(true);
						}
					}}
				>
					{copied ? (
						<CheckIcon aria-hidden="true" />
					) : (
						<CopyIcon aria-hidden="true" />
					)}
				</Button>
			</div>
			<p
				role="status"
				className={failed ? "mt-2 text-xs text-destructive" : "sr-only"}
			>
				{failed ? m.settings_copy_failed() : copied ? m.settings_copied() : ""}
			</p>
		</div>
	);
}

/** A read-only identifier in a card, as shown on the general settings pages. */
export function IdentifierCard({ value }: { value: string }) {
	return (
		<div className="max-w-2xl rounded-md border bg-card p-4">
			<IdentifierField value={value} />
		</div>
	);
}
