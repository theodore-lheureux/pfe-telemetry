import { m } from "@pfe/i18n/messages";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

export function TokenReveal({
	token,
	name,
	onDismiss,
}: {
	token: string;
	name: string;
	onDismiss: () => void;
}) {
	const title = useRef<HTMLHeadingElement>(null);
	const [copyMessage, setCopyMessage] = useState("");
	useEffect(() => {
		title.current?.focus();
	}, []);
	async function copy() {
		try {
			await navigator.clipboard.writeText(token);
			setCopyMessage(m.token_copied_save_it_in_the_private_token());
		} catch {
			setCopyMessage(m.clipboard_access_was_denied_or_is_unavailable_select());
		}
	}
	return (
		<section
			className="flex flex-col gap-3 rounded-lg border-2 border-ring p-5"
			aria-labelledby="token-reveal-title"
		>
			<h2
				ref={title}
				id="token-reveal-title"
				tabIndex={-1}
				className="font-semibold"
			>
				{m.save_token_named({ name })}
			</h2>
			<p className="text-sm">
				{m.this_is_the_only_reveal_the_credential_list()}
			</p>
			<Label htmlFor="collector-token">{m.onetime_collector_token()}</Label>
			<Textarea
				id="collector-token"
				readOnly
				value={token}
				autoComplete="off"
				spellCheck={false}
				rows={3}
				className="font-mono"
			/>
			<div className="flex flex-wrap gap-2">
				<Button type="button" onClick={() => void copy()}>
					{m.copy_token()}
				</Button>
				<Button type="button" variant="outline" onClick={onDismiss}>
					{m.i_saved_the_token_hide_it()}
				</Button>
			</div>
			<p role="status" className="text-sm">
				{copyMessage}
			</p>
		</section>
	);
}
