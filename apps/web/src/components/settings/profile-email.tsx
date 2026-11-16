import { m } from "@recount/i18n/messages";
import { getRouteApi, useHydrated } from "@tanstack/react-router";
import { DialogActions } from "../dialog-actions";
import { FormFeedback } from "../form-feedback";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useProfileEmailChange } from "./use-profile-email-change";

export function ProfileEmail() {
	const { user } = getRouteApi("/_app").useRouteContext();
	const form = useProfileEmailChange(user);
	const hydrated = useHydrated();
	return (
		<Dialog
			open={!!form.open}
			onOpenChange={(open) => {
				if (!open) form.close();
			}}
		>
			<div className="flex flex-col gap-2">
				<Label htmlFor="profile-email">{m.email_address()}</Label>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						id="profile-email"
						type="email"
						value={user.email}
						readOnly
						className="max-w-md"
					/>
					<DialogTrigger asChild>
						<Button
							variant="outline"
							type="button"
							onClick={(event) => {
								event.preventDefault();
								void form.start();
							}}
							disabled={!hydrated || !form.accountMatches}
						>
							{m.profile_email_change_title()}
						</Button>
					</DialogTrigger>
				</div>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{m.profile_email_change_title()}</DialogTitle>
						<DialogDescription>
							{m.profile_email_change_description()}
						</DialogDescription>
					</DialogHeader>
					<form
						className="flex flex-col gap-4"
						aria-busy={form.pending}
						onSubmit={(event) => {
							event.preventDefault();
							void form.submit();
						}}
					>
						{form.sent ? (
							<p role="status" className="text-sm text-muted-foreground">
								{m.profile_email_change_received({ email: form.address })}
							</p>
						) : (
							<div className="flex flex-col gap-2">
								<Label htmlFor="profile-email-new">
									{m.profile_email_change_new()}
								</Label>
								<Input
									id="profile-email-new"
									type="email"
									autoComplete="email"
									required
									maxLength={254}
									value={form.address}
									onChange={(event) => form.setAddress(event.target.value)}
									disabled={form.pending}
									aria-describedby="profile-email-feedback"
								/>
							</div>
						)}
						<p className="text-sm text-muted-foreground">
							{m.profile_email_change_effects()}
						</p>
						<p className="text-sm text-muted-foreground">
							{m.profile_email_change_recovery()}
						</p>
						<FormFeedback
							id="profile-email-feedback"
							message={form.message}
							kind="error"
							pending={form.pending}
						/>
						<DialogActions
							cancel={{
								label: form.sent ? m.close() : m.cancel(),
								onClick: form.close,
								disabled: form.pending,
							}}
						>
							{!form.sent && (
								<Button
									type="submit"
									disabled={form.pending || !form.accountMatches}
								>
									{m.profile_email_change_send()}
								</Button>
							)}
						</DialogActions>
					</form>
				</DialogContent>
			</div>
		</Dialog>
	);
}
