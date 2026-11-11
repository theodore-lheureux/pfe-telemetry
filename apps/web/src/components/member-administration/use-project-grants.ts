import { m } from "@recount/i18n/messages";
import { useRef } from "react";
import type {
	ProjectRole,
	ProjectSummary,
} from "../../organizations/contracts";
import type { MemberSummary } from "../../organizations/member-contracts";
import {
	removeProjectMember,
	setProjectMember,
} from "../../organizations/organization.functions";
import { useAppMutation } from "../use-app-mutation";
import { usePageConfirmation } from "../use-page-confirmation";

export function useProjectGrants(project: ProjectSummary, userId: string) {
	const heading = useRef<HTMLHeadingElement>(null);
	const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
	const [confirmation, setConfirmation] = usePageConfirmation<{
		memberId: string;
		role: ProjectRole | null;
	}>();
	const mutation = useAppMutation<
		{ member: MemberSummary; role: ProjectRole | null },
		unknown
	>({
		userId,
		save: ({ member, role }, signal) => {
			const data = {
				organizationId: project.organizationId,
				projectId: project.id,
				memberId: member.id,
			};
			return role
				? setProjectMember({ data: { ...data, role }, signal })
				: removeProjectMember({ data, signal });
		},
		saved: m.your_project_grant_change_was_saved(),
		refreshFailed: m.your_project_grant_change_was_saved_but_the(),
		unknown: m.the_grant_change_could_not_be_completed_refresh(),
	});
	async function change(member: MemberSummary, role: ProjectRole | null) {
		const saved = await mutation.submit({ member, role });
		if (!saved || saved.error) return;
		setConfirmation(null);
		const refreshed = await saved.refresh(
			async (navigate) => {
				if (
					member.userId !== userId ||
					member.role !== "member" ||
					role === "admin"
				)
					return;
				const destination = {
					to: "/organizations/$organizationId",
					params: { organizationId: project.organizationId },
					replace: true,
				} as const;
				await navigate(destination);
			},
			role
				? m.project_grant_saved()
				: m.explicit_project_grant_removed_organization_owner_and_administrator(),
		);
		if (refreshed) heading.current?.focus();
	}
	return {
		projectId: project.id,
		heading,
		confirmationTrigger,
		pending: mutation.pending,
		disabled: mutation.disabled,
		message: mutation.message,
		failed: mutation.kind !== "success",
		confirmation,
		setConfirmation,
		change,
		requestConfirmation(
			memberId: string,
			role: ProjectRole | null,
			trigger: HTMLButtonElement | null,
		) {
			confirmationTrigger.current = trigger;
			mutation.clearMessage();
			setConfirmation({ memberId, role });
		},
	};
}
