import { m } from "@recount/i18n/messages";
import { SendIcon } from "lucide-react";
import type { OrganizationRole } from "../../organizations/contracts";
import { Button } from "../ui/button";
import { NativeSelectOption } from "../ui/native-select";
import type { useOrganizationInvitations } from "./use-organization-invitations";

export function InvitationForm({
	state,
	organizationRole,
}: {
	state: ReturnType<typeof useOrganizationInvitations>;
	organizationRole: OrganizationRole;
}) {
	const { form, disabled } = state;
	return (
		<form
			method="post"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (!disabled) void form.handleSubmit();
			}}
			className="flex flex-wrap items-end gap-3"
		>
			<form.AppField name="email">
				{(field) => (
					<field.TextField
						id="invitation-email"
						label={m.email_address()}
						type="email"
						autoComplete="off"
						required
						maxLength={254}
						disabled={disabled}
					/>
				)}
			</form.AppField>
			<form.AppField name="role">
				{(field) => (
					<field.SelectField
						id="invitation-role"
						label={m.organization_role()}
						disabled={disabled}
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
			<Button
				type="submit"
				disabled={disabled}
				pending={state.sending}
				pendingLabel={m.sending_invitation()}
			>
				<SendIcon aria-hidden="true" />
				{m.send_invitation()}
			</Button>
		</form>
	);
}
