import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { useAppForm } from "../components/app-form";
import { FormFeedback } from "../components/form-feedback";
import { useLocaleChangeBlocker } from "../components/locale-safety";
import { Button } from "../components/ui/button";
import { validationError } from "../lib/form-validation";
import { inputMessage } from "../lib/operation-message";
import type { ExecutionReference } from "./contracts";
import { parseTimestamp } from "./validation";

export function RangeForm({
	reference,
	from,
	to,
}: {
	reference: ExecutionReference;
	from: Date;
	to: Date;
}) {
	const router = useRouter();
	const hydrated = useHydrated();
	const form = useAppForm({
		defaultValues: { from: from.toISOString(), to: to.toISOString() },
		validators: {
			onSubmit: ({ value }) =>
				validationError(() => {
					parseTimestamp(value.from);
					parseTimestamp(value.to);
				}),
		},
		onSubmit: async ({ value, formApi }) => {
			try {
				await router.navigate({
					to: "/organizations/$organizationId/projects/$projectId/executions/$executionId",
					params: reference,
					search: {
						from: parseTimestamp(value.from),
						to: parseTimestamp(value.to),
					},
				});
			} catch (error) {
				formApi.setErrorMap({ onSubmit: inputMessage(error) });
			}
		},
	});
	const message = useSelector(form.store, (state) => state.errorMap.onSubmit);
	const pending = useSelector(form.store, (state) => state.isSubmitting);
	useLocaleChangeBlocker(pending);
	return (
		<form
			method="get"
			aria-busy={pending}
			className="flex flex-wrap items-end gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				void form.handleSubmit();
			}}
		>
			<form.AppField name="from">
				{(field) => (
					<field.TextField
						label={m.start_utc_iso()}
						required
						disabled={!hydrated || pending}
					/>
				)}
			</form.AppField>
			<form.AppField name="to">
				{(field) => (
					<field.TextField
						label={m.end_utc_iso()}
						required
						disabled={!hydrated || pending}
					/>
				)}
			</form.AppField>
			<Button
				type="submit"
				disabled={!hydrated || pending}
				pending={pending}
				pendingLabel={m.loading()}
			>
				{m.apply_interval()}
			</Button>
			<FormFeedback
				message={message ?? ""}
				kind="error"
				pending={pending}
				pendingMessage={m.loading()}
				className="basis-full"
			/>
		</form>
	);
}
