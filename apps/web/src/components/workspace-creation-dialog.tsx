import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { generatedSlug } from "../lib/slug";
import type { OrganizationSummary } from "../organizations/contracts";
import {
	createOrganization,
	createProject,
} from "../organizations/organization.functions";
import { useAppForm } from "./app-form";
import { DialogActions } from "./dialog-actions";
import { validateName } from "./entity-form";
import { FormFeedback } from "./form-feedback";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { useAppMutation } from "./use-app-mutation";

export function WorkspaceCreationDialog({
	kind,
	organization,
	userId,
	onClose,
}: {
	kind: "organization" | "project";
	organization?: OrganizationSummary;
	userId: string;
	onClose: () => void;
}) {
	const title =
		kind === "organization" ? m.create_organization() : m.create_project();
	const mutation = useAppMutation<
		{ name: string; slug?: string; requestId: string },
		unknown
	>({
		userId,
		receiptBacked: kind === "project",
		save: async (input, signal) => {
			if (kind === "organization")
				return createOrganization({
					data: { name: input.name, slug: input.slug ?? "" },
					signal,
				});
			if (!organization || organization.role === "member")
				return {
					data: null,
					error: {
						code: "FORBIDDEN",
						message: "Organization administrator access is required",
					},
				};
			return createProject({
				data: {
					name: input.name,
					requestId: input.requestId,
					organizationId: organization.id,
				},
				signal,
			});
		},
	});
	async function settle(result: Awaited<ReturnType<typeof mutation.submit>>) {
		if (result && !result.error && (await result.refresh())) onClose();
	}
	const form = useAppForm({
		defaultValues: { name: "" },
		onSubmit: async ({ value }) => {
			const name = value.name.trim();
			if (
				!name ||
				mutation.disabled ||
				(kind === "project" &&
					(!organization || organization.role === "member"))
			)
				return;
			const requestId = crypto.randomUUID();
			await settle(
				await mutation.submit({
					name,
					...(kind === "organization" && {
						slug: generatedSlug(name, requestId, kind),
					}),
					requestId,
				}),
			);
		},
	});
	const sending = useSelector(form.store, (state) => state.isSubmitting);
	const pending = mutation.pending || sending;
	const disabled =
		mutation.disabled ||
		pending ||
		mutation.status === "uncertain" ||
		mutation.status === "refresh-failed";
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !pending) onClose();
			}}
		>
			<DialogContent
				className="sm:max-w-lg"
				showCloseButton={!pending}
				onEscapeKeyDown={(event) => {
					if (pending) event.preventDefault();
				}}
				onInteractOutside={(event) => {
					if (pending) event.preventDefault();
				}}
			>
				<DialogHeader className="border-b pb-4 pr-8">
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						{kind === "organization"
							? m.workspace_organization_description()
							: m.project_organization_help({
									organization: organization?.name ?? "",
								})}
					</DialogDescription>
				</DialogHeader>
				<form
					method="post"
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						if (!disabled) void form.handleSubmit();
					}}
				>
					<form.AppField
						name="name"
						validators={{ onChange: ({ value }) => validateName(value) }}
					>
						{(field) => (
							<field.TextField
								label={
									kind === "organization"
										? m.organization_name()
										: m.project_name()
								}
								required
								maxLength={120}
								disabled={disabled}
								autoComplete="off"
							/>
						)}
					</form.AppField>
					<FormFeedback
						message={mutation.message}
						kind={mutation.kind}
						pending={pending}
						reserveLine={false}
					/>
					<DialogActions
						cancel={{ label: m.cancel(), disabled: pending, onClick: onClose }}
					>
						{mutation.canRetry ? (
							<Button
								type="button"
								disabled={pending}
								onClick={() => void mutation.retry().then(settle)}
							>
								{m.retry_same_create()}
							</Button>
						) : (
							<Button type="submit" pending={pending} disabled={disabled}>
								{title}
							</Button>
						)}
					</DialogActions>
				</form>
			</DialogContent>
		</Dialog>
	);
}
