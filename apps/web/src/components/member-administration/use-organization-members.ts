import { m } from "@pfe/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { operationMessage } from "../../lib/operation-message";
import type {
	OrganizationRole,
	OrganizationSummary,
} from "../../organizations/contracts";
import {
	leaveOrganization,
	removeOrganizationMember,
	updateOrganizationMemberRole,
} from "../../organizations/member.functions";
import { useLocaleChangeBlocker } from "../locale-safety";
import { useAdministrationOperation } from "./use-administration-operation";

export type MemberChange =
	| { action: "leave" }
	| { action: "remove"; memberId: string }
	| { action: "role"; memberId: string; role: OrganizationRole };

export function useOrganizationMembers(
	organization: OrganizationSummary,
	userId: string,
) {
	const hydrated = useHydrated();
	const { router, begin } = useAdministrationOperation(userId);
	const heading = useRef<HTMLHeadingElement>(null);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const [failed, setFailed] = useState(false);
	const [confirm, setConfirm] = useState<string | null>(null);
	useLocaleChangeBlocker(pending);

	async function change(input: MemberChange) {
		if (!hydrated) return;
		const operation = begin(() => {
			setPending(false);
			setConfirm(null);
		});
		if (!operation) return;
		setPending(true);
		setMessage("");
		setFailed(false);
		let applied = false;
		try {
			const data = { organizationId: organization.id };
			const result =
				input.action === "leave"
					? await leaveOrganization({ data, signal: operation.signal })
					: input.action === "remove"
						? await removeOrganizationMember({
								signal: operation.signal,
								data: { ...data, memberId: input.memberId },
							})
						: await updateOrganizationMemberRole({
								signal: operation.signal,
								data: { ...data, memberId: input.memberId, role: input.role },
							});
			if (!operation.current()) return;
			if (result.error) {
				setFailed(true);
				setMessage(operationMessage(result.error));
				if (
					["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"].includes(
						result.error.code,
					)
				)
					await router.invalidate({ sync: true });
				return;
			}
			setConfirm(null);
			applied = true;
			if (input.action === "leave") {
				await router.navigate({ to: "/", replace: true });
				return;
			}
			if (
				!(await operation.refresh(
					m.your_membership_change_was_saved(),
					m.your_membership_change_was_saved_but_the_page(),
				))
			)
				return;
			heading.current?.focus();
			setMessage(
				input.action === "role"
					? m.member_role_updated()
					: m.membership_removed(),
			);
		} catch {
			if (!operation.current()) return;
			setFailed(true);
			setMessage(
				applied
					? m.the_membership_changed_but_the_page_could_not()
					: m.the_member_change_could_not_be_completed_refresh(),
			);
		} finally {
			operation.finish();
			if (operation.current()) setPending(false);
		}
	}

	return {
		heading,
		pending,
		disabled: !hydrated || pending,
		message,
		failed,
		confirm,
		setConfirm,
		change,
		requestRemoval(memberId: string) {
			setMessage("");
			setFailed(false);
			setConfirm(memberId);
		},
	};
}
