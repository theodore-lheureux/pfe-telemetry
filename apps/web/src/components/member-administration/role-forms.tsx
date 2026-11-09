import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { SaveIcon } from "lucide-react";
import { useRef } from "react";
import type {
	OrganizationRole,
	ProjectRole,
} from "../../organizations/contracts";
import type { MemberSummary } from "../../organizations/member-contracts";
import { useAppForm } from "../app-form";
import { Button } from "../ui/button";
import { NativeSelectOption } from "../ui/native-select";

export function MemberRoleForm({
	member,
	allowOwner,
	disabled,
	onSave,
}: {
	member: MemberSummary;
	allowOwner: boolean;
	disabled: boolean;
	onSave: (role: OrganizationRole) => Promise<void>;
}) {
	const form = useAppForm({
		defaultValues: { role: member.role },
		onSubmit: async ({ value }) => {
			if (!disabled) await onSave(value.role);
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
						value === "member" ||
						value === "admin" ||
						(allowOwner && value === "owner")
							? undefined
							: m.error_required(),
				}}
			>
				{(field) => (
					<field.SelectField
						id={`role-${member.id}`}
						label={m.role_for({ email: member.email })}
						disabled={disabled || submitting}
					>
						<NativeSelectOption value="member">
							{m.role_member()}
						</NativeSelectOption>
						<NativeSelectOption value="admin">
							{m.role_admin()}
						</NativeSelectOption>
						{allowOwner && (
							<NativeSelectOption value="owner">
								{m.role_owner()}
							</NativeSelectOption>
						)}
					</field.SelectField>
				)}
			</form.AppField>
			<Button
				type="submit"
				variant="outline"
				disabled={disabled || submitting}
				aria-label={
					submitting
						? `${m.saving()} ${m.role_for({ email: member.email })}`
						: m.save_role_for({ email: member.email })
				}
				pending={submitting}
				pendingLabel={m.saving()}
			>
				<SaveIcon aria-hidden="true" />
				{m.save_role()}
			</Button>
		</form>
	);
}

export function ProjectGrantForm({
	member,
	role,
	disabled,
	onSave,
	compact = false,
}: {
	member: MemberSummary;
	role?: ProjectRole;
	disabled: boolean;
	compact?: boolean;
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
			className={
				compact
					? "flex flex-wrap items-end gap-2 [&_label]:sr-only"
					: "flex flex-wrap items-end gap-2"
			}
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
						id={`grant-${member.id}`}
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
				size={compact ? "icon" : "default"}
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
				<span className={compact ? "sr-only" : undefined}>
					{role ? m.save_grant() : m.grant_access()}
				</span>
			</Button>
		</form>
	);
}
