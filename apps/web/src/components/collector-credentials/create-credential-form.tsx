import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { MAX_U64_NANOSECONDS_DURATION_SECONDS } from "../../credentials/contracts";
import { credentialFormValues } from "../../credentials/setup";
import { validationError } from "../../lib/form-validation";
import { useAppForm } from "../app-form";
import { FormFeedback } from "../form-feedback";
import { Button } from "../ui/button";
import type { CredentialValues } from "./use-collector-credentials";

export function CreateCredentialForm({
	disabled,
	create,
	feedback,
}: {
	disabled: boolean;
	create: (values: CredentialValues) => Promise<boolean>;
	feedback: { message: string; failed: boolean };
}) {
	const form = useAppForm({
		defaultValues: {
			name: "",
			sourceId: "",
			rootId: "",
			expiresAt: "",
			maximumSubmissionAge: "3600",
			allowedClockSkew: "60",
		},
		validators: {
			onSubmit: ({ value }) =>
				validationError(() => credentialFormValues(value)),
		},
		onSubmit: async ({ value }) => {
			if (!disabled && (await create(credentialFormValues(value))))
				form.reset();
		},
	});
	const error = useSelector(form.store, (state) => state.errorMap.onSubmit);
	const submitting = useSelector(form.store, (state) => state.isSubmitting);
	return (
		<section
			className="rounded-lg border bg-card p-5 text-card-foreground"
			aria-labelledby="create-credential-title"
		>
			<h2 id="create-credential-title" className="mb-4 font-semibold">
				{m.create_collector_credential()}
			</h2>
			<form
				method="post"
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					void form.handleSubmit();
				}}
			>
				<fieldset
					disabled={disabled || submitting}
					className="flex flex-col gap-4"
				>
					<legend className="sr-only">
						{m.credential_and_enrollment_policy()}
					</legend>
					<form.AppField name="name">
						{(field) => (
							<field.TextField
								id="credential-name"
								label={m.credential_name()}
								required
								maxLength={120}
								placeholder={m.for_example_staging_collector()}
							/>
						)}
					</form.AppField>
					<form.AppField name="sourceId">
						{(field) => (
							<field.TextField
								id="credential-source"
								label={m.source_id()}
								required
								maxLength={128}
								placeholder={m.for_example_loadtestrunner()}
								description={m.source_help()}
							/>
						)}
					</form.AppField>
					<form.AppField name="rootId">
						{(field) => (
							<field.TextField
								id="credential-root"
								label={m.enrolled_root_id()}
								required
								maxLength={128}
								description={m.enrolled_root_help()}
							/>
						)}
					</form.AppField>
					<form.AppField name="expiresAt">
						{(field) => (
							<field.TextField
								id="credential-expiry"
								label={m.expires_at_your_local_time_optional()}
								type="datetime-local"
							/>
						)}
					</form.AppField>
					<details>
						<summary className="cursor-pointer text-sm font-medium">
							{m.submission_timing_policy()}
						</summary>
						<div className="mt-3 flex flex-col gap-3">
							<form.AppField name="maximumSubmissionAge">
								{(field) => (
									<field.TextField
										id="credential-maximum-age"
										label={m.maximum_submission_age_seconds()}
										type="number"
										required
										min={1}
										max={MAX_U64_NANOSECONDS_DURATION_SECONDS}
										step={1}
									/>
								)}
							</form.AppField>
							<form.AppField name="allowedClockSkew">
								{(field) => (
									<field.TextField
										id="credential-clock-skew"
										label={m.allowed_clock_skew_seconds()}
										type="number"
										required
										min={0}
										max={MAX_U64_NANOSECONDS_DURATION_SECONDS}
										step={1}
									/>
								)}
							</form.AppField>
						</div>
					</details>
					<Button
						type="submit"
						className="self-start"
						pending={submitting}
						pendingLabel={m.creating_credential()}
					>
						{m.create_credential()}
					</Button>
					<FormFeedback
						message={error || feedback.message}
						kind={error || feedback.failed ? "error" : "success"}
						pending={submitting}
						pendingMessage={m.creating_credential()}
					/>
				</fieldset>
			</form>
		</section>
	);
}
