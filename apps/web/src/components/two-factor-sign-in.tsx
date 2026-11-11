import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AuthCard } from "./auth-card";
import { ActionStack } from "./dialog-actions";
import { FormFeedback } from "./form-feedback";
import { Button } from "./ui/button";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./ui/input-otp";
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
	function toggleBackup() {
		setBackup(!backup);
		setCode("");
		setMessage("");
		requestAnimationFrame(() => input.current?.focus());
	}
	return (
		<AuthCard
			title={m.two_factor_signin_title()}
			description={m.two_factor_signin_description()}
		>
			<form
				method="post"
				className="flex flex-col gap-4"
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
				{backup ? (
					<div className="flex flex-col gap-2">
						<Label htmlFor="two-factor-code">
							{m.two_factor_recovery_code()}
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
							maxLength={32}
							required
							disabled={!hydrated || pending}
							aria-invalid={!!message}
							aria-describedby="two-factor-feedback"
						/>
					</div>
				) : (
					<Field data-invalid={!!message} className="items-center gap-2">
						<FieldLabel htmlFor="two-factor-code" className="sr-only">
							{m.two_factor_authenticator_code()}
						</FieldLabel>
						<div className="flex justify-center">
							<InputOTP
								ref={input}
								id="two-factor-code"
								value={code}
								onChange={(value) => {
									setCode(value);
									setMessage("");
								}}
								inputMode="numeric"
								autoComplete="one-time-code"
								pattern={REGEXP_ONLY_DIGITS}
								maxLength={6}
								required
								disabled={!hydrated || pending}
								aria-invalid={!!message}
								aria-describedby="two-factor-feedback"
								pasteTransformer={(value) => value.replace(/\D/g, "")}
								pushPasswordManagerStrategy="increase-width"
							>
								<InputOTPGroup aria-hidden="true">
									{[0, 1, 2, 3, 4, 5].map((index) => (
										<InputOTPSlot
											key={index}
											index={index}
											aria-invalid={!!message}
										/>
									))}
								</InputOTPGroup>
							</InputOTP>
						</div>
					</Field>
				)}
				<FormFeedback
					id="two-factor-feedback"
					message={message}
					kind="error"
					reserveLine={false}
				/>
				<ActionStack>
					<Button
						type="submit"
						disabled={!hydrated || pending}
						pending={pending}
						pendingLabel={m.verifying_code()}
					>
						{m.two_factor_verify()}
					</Button>
					<div className="-mx-2 flex flex-wrap items-center justify-between gap-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="text-muted-foreground"
							disabled={!hydrated || pending}
							onClick={onBack}
						>
							<ArrowLeftIcon aria-hidden="true" />
							{m.two_factor_different_account()}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="text-muted-foreground"
							disabled={!hydrated || pending}
							onClick={toggleBackup}
						>
							{backup
								? m.two_factor_use_authenticator()
								: m.two_factor_use_recovery()}
						</Button>
					</div>
				</ActionStack>
			</form>
		</AuthCard>
	);
}
