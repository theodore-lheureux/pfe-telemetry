import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import {
	type NavigateFn,
	useLocation,
	useRouteContext,
} from "@tanstack/react-router";
import { cn } from "cn";
import { PlusIcon, SaveIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { operationMessage } from "../lib/operation-message";
import type { OperationResult } from "../lib/operation-result";
import { generatedSlug } from "../lib/slug";
import { useAppForm } from "./app-form";
import { FormFeedback } from "./form-feedback";
import { Button } from "./ui/button";
import { useAppMutation } from "./use-app-mutation";

interface CreateEntityInput {
	name: string;
	/** Only organizations have slugs; the auth library requires a unique one. */
	slug?: string;
	requestId: string;
}

interface CreateEntityFormProps<T> {
	children?: ReactNode;
	/** Generates a hidden slug from the name, falling back to this base, such as "organization". */
	slugFallback?: string;
	className?: string;
	reserveFeedbackLine?: boolean;
	receiptBacked?: boolean;
	submitLabel: string;
	save: (
		input: CreateEntityInput,
		signal: AbortSignal,
	) => Promise<OperationResult<T>>;
	onSuccess: (data: T, navigate: NavigateFn) => Promise<void>;
}

export function CreateEntityForm<T>(props: CreateEntityFormProps<T>) {
	const { user } = useRouteContext({ from: "/_app" });
	const locationKey = useLocation({
		select: (location) => location.state.__TSR_key,
	});
	return (
		<CreateFields
			key={`${user.id}/${locationKey}`}
			{...props}
			userId={user.id}
		/>
	);
}

function CreateFields<T>({
	children,
	className,
	reserveFeedbackLine = true,
	submitLabel,
	save,
	onSuccess,
	receiptBacked,
	userId,
	slugFallback,
}: CreateEntityFormProps<T> & { userId: string }) {
	const form = useAppForm({
		defaultValues: { name: "" },
		onSubmit: async ({ value }) => {
			const name = value.name.trim();
			const requestId = crypto.randomUUID();
			await settle(
				await mutation.submit({
					name,
					...(slugFallback && {
						slug: generatedSlug(name, requestId, slugFallback),
					}),
					requestId,
				}),
			);
		},
	});
	const mutation = useAppMutation({
		userId,
		save,
		receiptBacked,
		errorMessage: operationMessage,
	});
	async function settle(result: Awaited<ReturnType<typeof mutation.submit>>) {
		if (!result) return;
		if (result.error) return;
		if (await result.refresh((navigate) => onSuccess(result.data, navigate)))
			form.reset({ name: result.input.name });
	}
	const submitting = useSelector(form.store, (state) => state.isSubmitting);
	const pending = submitting || mutation.pending;
	const disabled =
		mutation.disabled ||
		pending ||
		mutation.status === "uncertain" ||
		mutation.status === "refresh-failed";
	return (
		<EntityFormLayout
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (!disabled) void form.handleSubmit();
			}}
			className={className}
			pending={pending}
			disabled={disabled}
			submitLabel={submitLabel}
			create
			feedback={
				<FormFeedback
					reserveLine={reserveFeedbackLine}
					id="entity-message"
					message={mutation.message}
					kind={mutation.kind}
					pending={pending}
				/>
			}
			retry={
				mutation.canRetry && (
					<Button
						type="button"
						variant="outline"
						disabled={pending}
						onClick={() => void mutation.retry().then(settle)}
					>
						{m.retry_same_create()}
					</Button>
				)
			}
		>
			<form.AppField
				name="name"
				validators={{
					onChange: ({ value }) => validateName(value),
				}}
			>
				{(field) => <field.TextField {...namePresentation(disabled)} />}
			</form.AppField>
			{children}
		</EntityFormLayout>
	);
}

export function validateName(value: string) {
	return value.trim() ? undefined : m.enter_a_name_not_just_spaces();
}
function namePresentation(disabled: boolean) {
	return {
		id: "entity-name",
		label: m.name(),
		required: true,
		maxLength: 120,
		disabled,
		"aria-describedby": "entity-message",
		autoComplete: "off",
	} as const;
}

function EntityFormLayout({
	children,
	className,
	pending,
	disabled,
	submitLabel,
	create,
	feedback,
	retry,
	onSubmit,
}: {
	children: ReactNode;
	className?: string;
	pending: boolean;
	disabled: boolean;
	submitLabel: string;
	create?: boolean;
	feedback: ReactNode;
	retry?: ReactNode;
	onSubmit: ComponentProps<"form">["onSubmit"];
}) {
	return (
		<form
			method="post"
			onSubmit={onSubmit}
			className={cn(
				"flex max-w-xl flex-col gap-4 rounded-lg border bg-card p-5 text-card-foreground",
				className,
			)}
			aria-busy={pending}
		>
			{children}
			<div>
				<Button
					type="submit"
					disabled={disabled}
					pending={pending}
					pendingLabel={m.saving()}
				>
					{create ? (
						<PlusIcon aria-hidden="true" />
					) : (
						<SaveIcon aria-hidden="true" />
					)}
					{submitLabel}
				</Button>
			</div>
			{feedback}
			{retry}
		</form>
	);
}

interface RenameEntityFormProps<T> {
	name: string;
	labelHidden?: boolean;
	requireChanged?: boolean;
	children?: ReactNode;
	className?: string;
	reserveFeedbackLine?: boolean;
	submitLabel: string;
	save: (
		input: { name: string },
		signal: AbortSignal,
	) => Promise<OperationResult<T>>;
	onSuccess?: (data: T) => Promise<void>;
}
export function RenameEntityForm<T>(props: RenameEntityFormProps<T>) {
	const { user } = useRouteContext({ from: "/_app" });
	const locationKey = useLocation({
		select: (location) => location.state.__TSR_key,
	});
	return (
		<RenameFields
			key={`${user.id}/${locationKey}`}
			{...props}
			userId={user.id}
		/>
	);
}
function RenameFields<T>({
	name,
	requireChanged = false,
	children,
	className,
	reserveFeedbackLine = true,
	submitLabel,
	save,
	onSuccess,
	userId,
	labelHidden,
}: RenameEntityFormProps<T> & { userId: string }) {
	const mutation = useAppMutation({ userId, save });
	const form = useAppForm({
		defaultValues: { name },
		onSubmit: async ({ value }) => {
			const saved = await mutation.submit({ name: value.name.trim() });
			if (!saved || saved.error) return;
			if (
				await saved.refresh(onSuccess ? () => onSuccess(saved.data) : undefined)
			)
				form.reset(saved.input);
		},
	});
	const submitting = useSelector(form.store, (state) => state.isSubmitting);
	const unchanged = useSelector(form.store, (state) => state.isDefaultValue);
	const pending = mutation.pending || submitting;
	const disabled =
		mutation.disabled ||
		pending ||
		mutation.status === "uncertain" ||
		mutation.status === "refresh-failed";
	return (
		<EntityFormLayout
			className={className}
			pending={pending}
			disabled={disabled || (requireChanged && unchanged)}
			submitLabel={submitLabel}
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (!disabled) void form.handleSubmit();
			}}
			feedback={
				<FormFeedback
					id="entity-message"
					reserveLine={reserveFeedbackLine}
					message={mutation.message}
					kind={mutation.kind}
					pending={pending}
				/>
			}
		>
			<form.AppField
				name="name"
				validators={{ onChange: ({ value }) => validateName(value) }}
			>
				{(field) => (
					<field.TextField
						{...namePresentation(disabled)}
						labelHidden={labelHidden}
					/>
				)}
			</form.AppField>
			{children}
		</EntityFormLayout>
	);
}
