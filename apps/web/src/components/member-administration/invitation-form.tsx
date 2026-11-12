import { m } from "@recount/i18n/messages";
import { PlusIcon, XIcon } from "lucide-react";
import { useRef } from "react";
import { operationMessage } from "../../lib/operation-message";
import type { OrganizationRole } from "../../organizations/contracts";
import type { InvitationBatchItem } from "../../organizations/invitation-contracts";
import { MAX_INVITATION_RECIPIENTS } from "../../organizations/invitation-contracts";
import { isInvitationEmail } from "../../organizations/invitation-email";
import { DialogActions } from "../dialog-actions";
import { FormFeedback } from "../form-feedback";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { NativeSelectOption } from "../ui/native-select";
import type { useOrganizationInvitations } from "./use-organization-invitations";

function RecipientStatus({ result }: { result: InvitationBatchItem }) {
	if (result.status === "created")
		return <Badge variant="outline">{m.invite_recipient_created()}</Badge>;
	if (result.status === "rejected") return operationMessage(result.error);
	return m.invite_recipient_not_attempted();
}

export function InvitationForm({
	state,
	organizationRole,
	onCancel,
}: {
	state: ReturnType<typeof useOrganizationInvitations>;
	organizationRole: OrganizationRole;
	onCancel?: () => void;
}) {
	const { form, formDisabled: disabled } = state;
	const addButton = useRef<HTMLButtonElement>(null);
	return (
		<form
			method="post"
			aria-busy={state.formPending}
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (!disabled) void form.handleSubmit();
			}}
			className="flex min-h-0 flex-col"
		>
			<div className="flex flex-col gap-5 overflow-y-auto px-6 py-5">
				<div
					aria-hidden="true"
					className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_2rem] gap-3 text-sm font-semibold md:grid"
				>
					<span>{m.email_address()}</span>
					<span>{m.invite_name_optional()}</span>
					<span>{m.organization_role()}</span>
				</div>
				<form.AppField name="recipients" mode="array">
					{(recipients) => (
						<>
							<div className="space-y-3">
								{recipients.state.value.map((recipient, index) => {
									const result = state.outcomes[recipient.id];
									const created = result?.status === "created";
									const rowDisabled = disabled || created;
									const statusId = `invitation-result-${recipient.id}`;
									return (
										<fieldset
											key={recipient.id}
											disabled={rowDisabled}
											onChange={() => state.clearOutcome(recipient.id)}
											aria-label={m.invite_recipient({ number: index + 1 })}
											className="grid items-start gap-3 rounded-md bg-muted/60 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_2rem] md:[&_label]:sr-only"
										>
											<form.AppField name={`recipients[${index}].email`}>
												{(field) => (
													<field.TextField
														id={`invitation-email-${recipient.id}`}
														label={m.email_address()}
														type="email"
														autoComplete="off"
														placeholder="jane@example.com"
														required
														maxLength={254}
														disabled={rowDisabled}
														aria-describedby={result ? statusId : undefined}
													/>
												)}
											</form.AppField>
											<form.AppField
												name={`recipients[${index}].recipientName`}
											>
												{(field) => (
													<field.TextField
														label={m.invite_name_optional()}
														autoComplete="off"
														placeholder={m.invite_name_placeholder()}
														maxLength={100}
														disabled={rowDisabled}
													/>
												)}
											</form.AppField>
											<form.AppField name={`recipients[${index}].role`}>
												{(field) => (
													<field.SelectField
														label={m.organization_role()}
														disabled={rowDisabled}
													>
														<NativeSelectOption value="member">
															{m.role_member()}
														</NativeSelectOption>
														<NativeSelectOption value="admin">
															{m.role_admin()}
														</NativeSelectOption>
														{organizationRole === "owner" && (
															<NativeSelectOption value="owner">
																{m.role_owner()}
															</NativeSelectOption>
														)}
													</field.SelectField>
												)}
											</form.AppField>
											{recipients.state.value.length > 1 && (
												<Button
													type="button"
													variant="ghost"
													size="icon"
													disabled={rowDisabled}
													aria-label={m.invite_remove_recipient({
														number: index + 1,
													})}
													onClick={() => {
														recipients.removeValue(index);
														addButton.current?.focus();
													}}
												>
													<XIcon aria-hidden="true" />
												</Button>
											)}
											{result && (
												<p id={statusId} className="text-xs md:col-span-4">
													<RecipientStatus result={result} />
												</p>
											)}
										</fieldset>
									);
								})}
							</div>
							<div className="flex justify-end">
								<Button
									ref={addButton}
									type="button"
									variant="outline"
									disabled={
										disabled ||
										recipients.state.value.length >= MAX_INVITATION_RECIPIENTS
									}
									onClick={() =>
										recipients.pushValue({
											id: crypto.randomUUID(),
											email: "",
											recipientName: "",
											role: "member",
										})
									}
								>
									<PlusIcon aria-hidden="true" />
									{m.add()}
								</Button>
							</div>
						</>
					)}
				</form.AppField>
				<form.AppField name="message">
					{(field) => (
						<field.TextareaField
							label={m.invite_message_optional()}
							placeholder={m.invite_message_placeholder()}
							maxLength={2000}
							rows={3}
							disabled={disabled}
						/>
					)}
				</form.AppField>
				<FormFeedback
					message={state.message}
					kind={state.feedbackKind}
					pending={state.formPending}
					pendingMessage={state.pendingLabel}
				/>
			</div>
			<DialogActions
				className="m-0 shrink-0 rounded-none bg-transparent px-6 py-4"
				cancel={{
					label: m.cancel(),
					disabled: state.pending,
					onClick: onCancel ?? (() => state.setInviting(null)),
				}}
			>
				<form.Subscribe selector={(state) => state.values.recipients}>
					{(recipients) => {
						const emails = recipients.map((recipient) =>
							recipient.email.trim().toLowerCase(),
						);
						const valid =
							recipients.some(
								(recipient) =>
									state.outcomes[recipient.id]?.status !== "created",
							) &&
							emails.every(isInvitationEmail) &&
							new Set(emails).size === emails.length;
						return (
							<Button
								type="submit"
								disabled={disabled || !valid}
								pending={state.formPending}
								pendingLabel={state.pendingLabel}
							>
								{m.invite_team_members()}
							</Button>
						);
					}}
				</form.Subscribe>
			</DialogActions>
		</form>
	);
}
