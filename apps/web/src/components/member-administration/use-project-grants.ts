import { m } from "@pfe/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { operationMessage } from "../../lib/operation-message";
import type {
	ProjectRole,
	ProjectSummary,
} from "../../organizations/contracts";
import type { MemberSummary } from "../../organizations/member-contracts";
import {
	removeProjectMember,
	setProjectMember,
} from "../../organizations/organization.functions";
import { useLocaleChangeBlocker } from "../locale-safety";
import { useAdministrationOperation } from "./use-administration-operation";

export function useProjectGrants(project: ProjectSummary, userId: string) {
	const { router, begin } = useAdministrationOperation(userId);
	const hydrated = useHydrated();
	const heading = useRef<HTMLHeadingElement>(null);
	const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const [failed, setFailed] = useState(false);
	const [confirmation, setConfirmation] = useState<{
		memberId: string;
		role: ProjectRole | null;
	} | null>(null);
	useLocaleChangeBlocker(pending);

	async function change(member: MemberSummary, role: ProjectRole | null) {
		if (!hydrated) return;
		const operation = begin(() => {
			setPending(false);
			setConfirmation(null);
		});
		if (!operation) return;
		setPending(true);
		setFailed(false);
		setMessage("");
		let applied = false;
		try {
			const data = {
				organizationId: project.organizationId,
				projectId: project.id,
				memberId: member.id,
			};
			const result = role
				? await setProjectMember({
						data: { ...data, role },
						signal: operation.signal,
					})
				: await removeProjectMember({ data, signal: operation.signal });
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
			setConfirmation(null);
			applied = true;
			if (
				member.userId === userId &&
				member.role === "member" &&
				role !== "admin"
			) {
				await router.navigate({
					to: "/organizations/$organizationId",
					params: { organizationId: project.organizationId },
					replace: true,
				});
				return;
			}
			if (
				!(await operation.refresh(
					m.your_project_grant_change_was_saved(),
					m.your_project_grant_change_was_saved_but_the(),
				))
			)
				return;
			heading.current?.focus();
			setMessage(
				role
					? m.project_grant_saved()
					: m.explicit_project_grant_removed_organization_owner_and_administrator(),
			);
		} catch {
			if (!operation.current()) return;
			setFailed(true);
			setMessage(
				applied
					? m.the_project_grant_changed_but_the_page_could()
					: m.the_grant_change_could_not_be_completed_refresh(),
			);
		} finally {
			operation.finish();
			if (operation.current()) setPending(false);
		}
	}

	function requestConfirmation(
		memberId: string,
		role: ProjectRole | null,
		trigger: HTMLButtonElement | null,
	) {
		confirmationTrigger.current = trigger;
		setMessage("");
		setFailed(false);
		setConfirmation({ memberId, role });
	}

	return {
		heading,
		confirmationTrigger,
		pending,
		disabled: !hydrated || pending,
		message,
		failed,
		confirmation,
		setConfirmation,
		change,
		requestConfirmation,
	};
}
