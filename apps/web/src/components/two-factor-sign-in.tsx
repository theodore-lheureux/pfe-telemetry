import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { FormFeedback } from "./form-feedback";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function TwoFactorSignIn({
	onVerify,
	onBack,
}: {
	onVerify: (code: string, backup: boolean) => Promise<string | undefined>;
	onBack: () => void;
}) {
	const [code, setCode] = useState("");
	const [backup, setBackup] = useState(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const busy = useRef(false);
	const input = useRef<HTMLInputElement>(null);
	const mounted = useRef(false);
	const hydrated = useHydrated();
	useEffect(() => {
		mounted.current = true;
		if (hydrated) input.current?.focus();
		return () => {
			mounted.current = false;
		};
	}, [hydrated]);
	return (
		<main className="mx-auto my-8 flex w-[calc(100%_-_2rem)] max-w-md flex-col gap-5 rounded-lg border bg-card p-5 sm:my-16">
			<h1 className="text-[22px] font-medium">{m.two_factor_signin_title()}</h1>
			<p className="text-sm text-muted-foreground">
				{m.two_factor_signin_description()}
			</p>
			<form
				method="post"
				className="flex flex-col gap-3"
				onSubmit={async (event) => {
					event.preventDefault();
					if (busy.current || !hydrated) return;
					busy.current = true;
					setPending(true);
					setMessage("");
					try {
						const failure = await onVerify(code.trim(), backup);
						if (mounted.current) setMessage(failure ?? "");
					} finally {
						busy.current = false;
						if (mounted.current) setPending(false);
					}
				}}
			>
				<Label htmlFor="two-factor-code">
					{backup
						? m.two_factor_recovery_code()
						: m.two_factor_authenticator_code()}
				</Label>
				<Input
					ref={input}
					id="two-factor-code"
					value={code}
					onChange={(event) => {
						setCode(event.target.value);
						setMessage("");
					}}
					autoComplete="one-time-code"
					inputMode={backup ? "text" : "numeric"}
					pattern={backup ? undefined : "[0-9]{6}"}
					maxLength={backup ? 32 : 6}
					required
					disabled={!hydrated || pending}
				/>
				<Button
					type="submit"
					disabled={!hydrated || pending}
					pending={pending}
					pendingLabel={m.verifying_code()}
				>
					{m.two_factor_verify()}
				</Button>
			</form>
			<FormFeedback message={message} kind="error" reserveLine={false} />
			<Button
				variant="link"
				disabled={!hydrated || pending}
				onClick={() => {
					setBackup(!backup);
					setCode("");
					setMessage("");
				}}
			>
				{backup
					? m.two_factor_use_authenticator()
					: m.two_factor_use_recovery()}
			</Button>
			<Button
				variant="outline"
				disabled={!hydrated || pending}
				onClick={onBack}
			>
				{m.two_factor_different_account()}
			</Button>
		</main>
	);
}
