import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { SaveIcon } from "lucide-react";
import { useRef } from "react";
import type { ProjectRole } from "../../organizations/contracts";
import type { MemberSummary } from "../../organizations/member-contracts";
import { useAppForm } from "../app-form";
import { Button } from "../ui/button";
import { NativeSelectOption } from "../ui/native-select";

export function ProjectGrantForm({
	member,
	role,
	disabled,
	onSave,
}: {
	member: MemberSummary;
	role?: ProjectRole;
	disabled: boolean;
	onSave: (
		role: ProjectRole,
		trigger: HTMLButtonElement | null,
	) => Promise<void>;
}) {
	const submit = useRef<HTMLButtonElement>(null);
	const values: { role: ProjectRole } = { role: role ?? "viewer" };
	const form = useAppForm({
		defaultValues: values,
		onSubmit: async ({ value }) => {
			if (!disabled) await onSave(value.role, submit.current);
		},
	});
	const submitting = useSelector(form.store, (state) => state.isSubmitting);
	return (
		<form
			method="post"
			className="flex flex-wrap items-end gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (!disabled) void form.handleSubmit();
			}}
		>
			<form.AppField
				name="role"
				validators={{
					onChange: ({ value }) =>
						value === "viewer" || value === "member" || value === "admin"
							? undefined
							: m.error_required(),
				}}
			>
				{(field) => (
					<field.SelectField
						label={m.project_role_for({ email: member.email })}
						disabled={disabled || submitting}
					>
						<NativeSelectOption value="viewer">
							{m.role_viewer()}
						</NativeSelectOption>
						<NativeSelectOption value="member">
							{m.role_member()}
						</NativeSelectOption>
						<NativeSelectOption value="admin">
							{m.role_admin()}
						</NativeSelectOption>
					</field.SelectField>
				)}
			</form.AppField>
			<Button
				ref={submit}
				type="submit"
				variant="outline"
				disabled={disabled || submitting}
				aria-label={
					submitting
						? `${m.saving()} ${m.project_role_for({ email: member.email })}`
						: m.save_grant_for({ email: member.email })
				}
				pending={submitting}
				pendingLabel={m.saving()}
			>
				<SaveIcon aria-hidden="true" />
				{role ? m.save_grant() : m.grant_access()}
			</Button>
		</form>
	);
}
