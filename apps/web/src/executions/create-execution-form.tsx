import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useAppForm } from "../components/app-form";
import { FormFeedback } from "../components/form-feedback";
import { Button } from "../components/ui/button";
import { useAppMutation } from "../components/use-app-mutation";
import { validationError } from "../lib/form-validation";
import type { ProjectReference } from "../organizations/contracts";
import { createExecution } from "./execution.functions";
import { parseCreateExecution } from "./validation";

export function CreateExecutionForm({
	reference,
	sources,
	userId,
}: {
	reference: ProjectReference;
	sources: { nodeId: string; hostname: string }[];
	userId: string;
}) {
	const mutation = useAppMutation({
		userId,
		receiptBacked: true,
		transientNotice: true,
		save: (input: ReturnType<typeof parseCreateExecution>) =>
			createExecution({ data: input }),
		saved: m.execution_recorded_if_the_saved_execution_cannot_load(),
		refreshFailed: m.execution_recorded_but_its_page_could_not_load(),
		unknown: m.the_recording_response_did_not_arrive_check_the(),
	});
	async function settle(result: Awaited<ReturnType<typeof mutation.submit>>) {
		if (result && !result.error)
			await result.refresh(
				undefined,
				m.execution_recorded_if_the_saved_execution_cannot_load(),
			);
	}
	const form = useAppForm({
		defaultValues: {
			...reference,
			requestId: crypto.randomUUID(),
			name: "",
			nodeId: sources[0]?.nodeId ?? "",
			hostId: "",
			startedAt: "",
			endedAt: "",
		},
		validators: {
			onSubmit: ({ value }) =>
				validationError(() => parseCreateExecution(value)),
		},
		onSubmit: async ({ value }) => {
			await settle(await mutation.submit(parseCreateExecution(value)));
		},
	});
	const inputError = useSelector(
		form.store,
		(state) => state.errorMap.onSubmit,
	);
	const submitting = useSelector(form.store, (state) => state.isSubmitting);
	const pending = submitting || mutation.pending;
	const disabled =
		mutation.disabled ||
		pending ||
		["uncertain", "saved", "refresh-failed"].includes(mutation.status);
	return (
		<form
			method="post"
			aria-busy={pending}
			className="flex max-w-xl flex-col gap-4 rounded-md border bg-card p-5 text-card-foreground"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (!disabled) void form.handleSubmit();
			}}
		>
			<h2 className="font-semibold">{m.record_an_execution_interval()}</h2>
			<p className="text-sm text-muted-foreground">
				{m.choose_an_enrolled_source_the_fixed_source_optional()}
			</p>
			<form.AppField name="name">
				{(field) => (
					<field.TextField
						label={m.execution_name()}
						required
						maxLength={120}
						disabled={disabled}
					/>
				)}
			</form.AppField>
			<form.AppField name="nodeId">
				{(field) => (
					<field.SelectField
						label={m.collector_source()}
						required
						disabled={disabled}
					>
						{sources.map((source) => (
							<option key={source.nodeId} value={source.nodeId}>
								{source.hostname}
							</option>
						))}
					</field.SelectField>
				)}
			</form.AppField>
			<form.AppField name="hostId">
				{(field) => (
					<field.TextField
						label={m.host_id_optional_exact_match()}
						maxLength={128}
						disabled={disabled}
					/>
				)}
			</form.AppField>
			<form.AppField name="startedAt">
				{(field) => (
					<field.TextField
						label={m.start_utc_iso()}
						placeholder="2026-11-03T10:00:00Z"
						required
						disabled={disabled}
					/>
				)}
			</form.AppField>
			<form.AppField name="endedAt">
				{(field) => (
					<field.TextField
						label={m.end_utc_iso()}
						placeholder="2026-11-03T10:05:00Z"
						required
						disabled={disabled}
					/>
				)}
			</form.AppField>
			<Button
				type="submit"
				disabled={disabled}
				pending={pending}
				pendingLabel={m.recording()}
			>
				{m.record_execution()}
			</Button>
			<FormFeedback
				message={inputError || mutation.message}
				kind={inputError ? "error" : mutation.kind}
				pending={pending}
				pendingMessage={m.recording()}
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
			{mutation.data && (
				<Link
					to="/organizations/$organizationId/projects/$projectId/executions/$executionId"
					params={{ ...reference, executionId: mutation.data.executionId }}
					className="underline"
				>
					{m.open_saved_execution()}
				</Link>
			)}
		</form>
	);
}
