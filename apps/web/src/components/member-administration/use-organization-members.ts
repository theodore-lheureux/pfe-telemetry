import { m } from "@recount/i18n/messages";
import { useRef } from "react";
import type {
	OrganizationRole,
	OrganizationSummary,
} from "../../organizations/contracts";
import {
	leaveOrganization,
	removeOrganizationMember,
	updateOrganizationMemberRole,
} from "../../organizations/member.functions";
import { useAppMutation } from "../use-app-mutation";
import { usePageConfirmation } from "../use-page-confirmation";

export type MemberChange =
	| { action: "leave" }
	| { action: "remove"; memberId: string }
	| { action: "role"; memberId: string; role: OrganizationRole };

export function useOrganizationMembers(
	organization: OrganizationSummary,
	userId: string,
) {
	const heading = useRef<HTMLHeadingElement>(null);
	const [confirm, setConfirm] = usePageConfirmation<string>();
	const mutation = useAppMutation<MemberChange, unknown>({
		userId,
		save: (input, signal) => {
			const data = { organizationId: organization.id };
			if (input.action === "leave") return leaveOrganization({ data, signal });
			if (input.action === "remove")
				return removeOrganizationMember({
					data: { ...data, memberId: input.memberId },
					signal,
				});
			return updateOrganizationMemberRole({
				data: { ...data, memberId: input.memberId, role: input.role },
				signal,
			});
		},
		saved: m.your_membership_change_was_saved(),
		refreshFailed: m.your_membership_change_was_saved_but_the_page(),
		unknown: m.the_member_change_could_not_be_completed_refresh(),
	});
	async function change(input: MemberChange) {
		const saved = await mutation.submit(input);
		if (!saved || saved.error) return;
		setConfirm(null);
		const refreshed = await saved.refresh(
			async (navigate) => {
				if (input.action !== "leave") return;
				await navigate({ to: "/", replace: true });
			},
			input.action === "role"
				? m.member_role_updated()
				: m.membership_removed(),
		);
		if (refreshed) heading.current?.focus();
	}
	return {
		heading,
		pending: mutation.pending,
		disabled: mutation.disabled,
		message: mutation.message,
		failed: mutation.kind !== "success",
		confirm,
		setConfirm,
		change,
		requestRemoval(memberId: string) {
			mutation.clearMessage();
			setConfirm(memberId);
		},
	};
}
