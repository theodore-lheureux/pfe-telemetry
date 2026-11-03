import { m } from "@pfe/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { useState } from "react";
import { credentialFormValues } from "../../credentials/setup";
import { inputMessage } from "../../lib/operation-message";
import { useAppForm } from "../app-form";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import type { CredentialValues } from "./use-collector-credentials";

export function CreateCredentialForm({
	disabled,
	create,
}: {
	disabled: boolean;
	create: (values: CredentialValues) => Promise<boolean>;
}) {
	const [error, setError] = useState("");
	const form = useAppForm({
		defaultValues: {
			name: "",
			sourceId: "",
			hosts: "",
			requireHostId: true,
			expiresAt: "",
			maximumSubmissionAge: "3600",
			allowedClockSkew: "60",
		},
		onSubmit: async ({ value }) => {
			if (disabled) return;
			setError("");
			let values: ReturnType<typeof credentialFormValues>;
			try {
				values = credentialFormValues(value);
			} catch (cause) {
				setError(inputMessage(cause));
				return;
			}
			if (await create(values)) form.reset();
		},
	});
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
								label={m.source_id()}
								required
								maxLength={128}
								placeholder={m.for_example_loadtestrunner()}
								description={m.source_help()}
							/>
						)}
					</form.AppField>
					<form.AppField name="hosts">
						{(field) => (
							<field.TextareaField
								label={m.allowed_host_ids_one_per_line()}
								rows={3}
								description={m.host_policy_help({
									flag: "--host-id",
									path: "/etc/machine-id",
								})}
							/>
						)}
					</form.AppField>
					<form.Field name="requireHostId">
						{(field) => (
							<Field>
								<div className="flex items-center gap-2">
									<Checkbox
										id="require-host-id"
										name={field.name}
										checked={field.state.value}
										onBlur={field.handleBlur}
										onCheckedChange={(checked) =>
											field.handleChange(checked === true)
										}
										aria-describedby="require-host-help"
									/>
									<FieldLabel htmlFor="require-host-id">
										{m.require_host_identification()}
									</FieldLabel>
								</div>
								<FieldDescription id="require-host-help">
									{m.if_unchecked_submissions_without_a_host_id_are()}
								</FieldDescription>
							</Field>
						)}
					</form.Field>
					<form.AppField name="expiresAt">
						{(field) => (
							<field.TextField
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
										label={m.maximum_submission_age_seconds()}
										type="number"
										required
										min={1}
										max={86400}
										step={1}
									/>
								)}
							</form.AppField>
							<form.AppField name="allowedClockSkew">
								{(field) => (
									<field.TextField
										label={m.allowed_clock_skew_seconds()}
										type="number"
										required
										min={1}
										max={3600}
										step={1}
									/>
								)}
							</form.AppField>
						</div>
					</details>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<Button type="submit" className="self-start">
						{m.create_credential()}
					</Button>
				</fieldset>
			</form>
		</section>
	);
}
