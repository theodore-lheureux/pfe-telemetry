import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { useLocation, useRouteContext } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import { operationMessage } from "../lib/operation-message";
import type {
	OperationResult,
	OrganizationInput,
} from "../organizations/contracts";
import { useAppForm } from "./app-form";
import { FormFeedback } from "./form-feedback";
import { Button } from "./ui/button";
import { useAppMutation } from "./use-app-mutation";

interface EntityFormProps<T> {
	children?: ReactNode;
	className?: string;
	requireChanged?: boolean;
	reserveFeedbackLine?: boolean;
	name?: string;
	slug?: boolean;
	receiptBacked?: boolean;
	submitLabel: string;
	save: (
		input: OrganizationInput & { requestId: string },
		signal: AbortSignal,
	) => Promise<OperationResult<T>>;
	onSuccess: (data: T, recover: (href: string) => void) => Promise<void>;
}

export function EntityForm<T>(props: EntityFormProps<T>) {
	const { user } = useRouteContext({ from: "/_app" });
	const locationKey = useLocation({
		select: (location) => location.state.__TSR_key,
	});
	return (
		<EntityFields
			key={`${user.id}/${locationKey}`}
			{...props}
			userId={user.id}
		/>
	);
}

function EntityFields<T>({
	children,
	className,
	requireChanged = false,
	reserveFeedbackLine = true,
	name = "",
	slug,
	submitLabel,
	save,
	onSuccess,
	receiptBacked,
	userId,
}: EntityFormProps<T> & { userId: string }) {
	const form = useAppForm({
		defaultValues: { name, slug: "" },
		onSubmit: async ({ value }) => {
			await settle(
				await mutation.submit({
					name: value.name.trim(),
					slug: value.slug,
					requestId: crypto.randomUUID(),
				}),
			);
		},
	});
	const mutation = useAppMutation({
		userId,
		save,
		receiptBacked,
		errorMessage: (error) =>
			error.code === "CONFLICT" && !error.reason && slug
				? m.this_slug_is_already_in_use_choose_another()
				: operationMessage(error),
	});
	async function settle(result: Awaited<ReturnType<typeof mutation.submit>>) {
		if (!result) return;
		if (result.error) {
			const error = result.error;
			if (error.code !== "CONFLICT" || error.reason || !slug) return;
			form.setFieldMeta("slug", (meta) => ({
				...meta,
				isTouched: true,
				errorMap: {
					...meta.errorMap,
					onSubmit: m.this_slug_is_already_in_use_choose_another(),
				},
			}));
			return;
		}
		if (await result.refresh((follow) => onSuccess(result.data, follow)))
			form.reset({ name: result.input.name, slug: result.input.slug });
	}
	const submitting = useSelector(form.store, (state) => state.isSubmitting);
	const unchanged = useSelector(form.store, (state) => state.isDefaultValue);
	const pending = submitting || mutation.pending;
	const disabled =
		mutation.disabled ||
		pending ||
		mutation.status === "uncertain" ||
		mutation.status === "refresh-failed";
	return (
		<form
			method="post"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (!disabled) void form.handleSubmit();
			}}
			className={cn(
				"flex max-w-xl flex-col gap-4 rounded-lg border bg-card p-5 text-card-foreground",
				className,
			)}
			aria-busy={pending}
		>
			<form.AppField
				name="name"
				validators={{
					onChange: ({ value }) =>
						!value.trim() ? m.enter_a_name_not_just_spaces() : undefined,
				}}
			>
				{(field) => (
					<field.TextField
						id="entity-name"
						label={m.name()}
						required
						maxLength={120}
						disabled={disabled}
						aria-describedby="entity-message"
						autoComplete="off"
					/>
				)}
			</form.AppField>
			{slug && (
				<form.AppField name="slug">
					{(field) => (
						<field.TextField
							id="entity-slug"
							label={m.slug()}
							required
							maxLength={63}
							pattern="[a-z0-9]+(-[a-z0-9]+)*"
							disabled={disabled}
							aria-describedby="entity-message"
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
							description={m.use_lowercase_letters_numbers_and_single_hyphens_the()}
						/>
					)}
				</form.AppField>
			)}
			{children}
			<div>
				<Button
					type="submit"
					disabled={disabled || (requireChanged && unchanged)}
					pending={pending}
					pendingLabel={m.saving()}
				>
					{submitLabel}
				</Button>
			</div>
			<FormFeedback
				reserveLine={reserveFeedbackLine}
				id="entity-message"
				message={mutation.message}
				kind={mutation.kind}
				pending={pending}
			/>
			{mutation.canRetry && (
				<Button
					type="button"
					variant="outline"
					disabled={pending}
					onClick={() => void mutation.retry().then(settle)}
				>
					{m.retry_same_create()}
				</Button>
			)}
		</form>
	);
}
