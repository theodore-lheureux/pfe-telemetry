import { m } from "@recount/i18n/messages";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import { useAppForm } from "../components/app-form";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Label } from "../components/ui/label";
import { NativeSelectOption } from "../components/ui/native-select";
import { useAppMutation } from "../components/use-app-mutation";
import { usePageConfirmation } from "../components/use-page-confirmation";
import type { ProjectReference } from "../organizations/contracts";
import {
	actions,
	cpuProfiles,
	gpuProfiles,
	parseWorkflow,
	type WorkflowAction,
	type WorkflowInput,
} from "./contracts";
import { runDeveloperWorkflow } from "./developer.functions";
import { WorkflowConfirmation } from "./workflow-confirmation";
import { WorkflowInfo } from "./workflow-info";
import {
	durationLabels,
	profileLabels,
	ttlLabels,
	workflowLabels,
} from "./workflow-labels";

export function WorkflowForm({
	userId,
	reference,
	gpuEnabled,
}: {
	userId: string;
	reference: ProjectReference;
	gpuEnabled: boolean;
}) {
	const client = useQueryClient();
	const [confirmation, setConfirmation] = usePageConfirmation<WorkflowInput>();
	const [invalid, setInvalid] = useState(false);
	const mutation = useAppMutation({
		userId,
		save: (data: WorkflowInput, signal) =>
			runDeveloperWorkflow({ data, signal }),
		saved: m.developer_queued(),
		unknown: m.developer_error(),
	});
	const labels = workflowLabels();
	const form = useAppForm({
		defaultValues: {
			action: "create-cpu" as WorkflowAction,
			lab: "",
			count: "1",
			ttl: "15m",
			fleet: "aws-cpu",
			cpuProfile: "cpu-hash",
			gpuProfile: "gpu-mixed",
			duration: "60",
			discard: false,
		},
		onSubmit: async ({ value }) => {
			setInvalid(false);
			try {
				const { cpuProfile, gpuProfile, ...fields } = value;
				const payload = {
					...reference,
					...fields,
					workload: undefined as string | undefined,
					fleet: fields.fleet as string | undefined,
					count: value.action === "create-gpu" ? "1" : value.count,
					discard: value.action === "move" && value.discard,
					confirmed: true,
				};
				if (value.action === "load-cpu" || value.action === "load-gpu") {
					payload.fleet = undefined;
					payload.workload =
						value.action === "load-cpu" ? cpuProfile : gpuProfile;
				}
				const input = parseWorkflow(payload);
				if (
					input.action.startsWith("create") ||
					input.action === "destroy" ||
					input.discard
				) {
					setConfirmation(input);
					return;
				}
				await run(input);
			} catch {
				setInvalid(true);
			}
		},
	});
	async function run(input: WorkflowInput) {
		const result = await mutation.submit(input);
		if (result && !result.error) {
			setConfirmation(null);
			await result.refresh(async () => {
				await client.invalidateQueries({
					queryKey: [
						"developer",
						userId,
						reference.organizationId,
						reference.projectId,
					],
				});
			}, m.developer_queued());
		}
	}
	const blocked =
		mutation.disabled ||
		["uncertain", "refresh-failed"].includes(mutation.status);
	return (
		<>
			<form
				className="space-y-4"
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				<form.AppField name="action">
					{(field) => (
						<field.SelectField label={m.developer_action()} className="w-full">
							{actions.map((action) => (
								<NativeSelectOption
									key={action}
									value={action}
									title={
										action === "create-gpu" && !gpuEnabled
											? m.developer_gpu_disabled()
											: undefined
									}
									disabled={action === "create-gpu" && !gpuEnabled}
								>
									{labels[action]}
								</NativeSelectOption>
							))}
						</field.SelectField>
					)}
				</form.AppField>
				<form.Subscribe selector={(state) => state.values.action}>
					{(action) => (
						<>
							<WorkflowInfo action={action} />
							{action.startsWith("create") && (
								<div className="grid grid-cols-2 items-end gap-3">
									{action === "create-cpu" && (
										<form.AppField name="count">
											{(field) => (
												<field.TextField
													label={m.developer_count()}
													type="number"
													min={1}
													max={200}
													required
												/>
											)}
										</form.AppField>
									)}
									{action.startsWith("create") && (
										<form.AppField name="ttl">
											{(field) => (
												<field.SelectField
													label={m.developer_ttl()}
													className="w-full"
												>
													{Object.entries(ttlLabels()).map(([ttl, label]) => (
														<NativeSelectOption key={ttl} value={ttl}>
															{label}
														</NativeSelectOption>
													))}
												</field.SelectField>
											)}
										</form.AppField>
									)}
								</div>
							)}
							{action !== "list" && (
								<form.AppField name="lab">
									{(field) => (
										<field.TextField
											label={m.developer_lab()}
											maxLength={24}
											pattern="[a-z][a-z0-9-]{0,23}"
											className="font-mono text-xs"
											placeholder={
												action.startsWith("create")
													? m.developer_generated()
													: "demo-…"
											}
											required={!action.startsWith("create")}
										/>
									)}
								</form.AppField>
							)}
							{[
								"configure",
								"move",
								"destroy",
								"load-status",
								"stop-load",
							].includes(action) && (
								<form.AppField name="fleet">
									{(field) => (
										<field.SelectField
											label={m.developer_fleet()}
											className="w-full"
										>
											<NativeSelectOption value="aws-cpu">
												AWS CPU
											</NativeSelectOption>
											<NativeSelectOption value="gcp-gpu">
												GCP GPU
											</NativeSelectOption>
										</field.SelectField>
									)}
								</form.AppField>
							)}
							{action === "load-cpu" && (
								<form.AppField name="cpuProfile">
									{(field) => (
										<field.SelectField
											label={m.developer_profile()}
											className="w-full"
										>
											{cpuProfiles.map((profile) => (
												<NativeSelectOption key={profile} value={profile}>
													{profileLabels()[profile]}
												</NativeSelectOption>
											))}
										</field.SelectField>
									)}
								</form.AppField>
							)}
							{action === "load-gpu" && (
								<form.AppField name="gpuProfile">
									{(field) => (
										<field.SelectField
											label={m.developer_profile()}
											className="w-full"
										>
											{gpuProfiles.map((profile) => (
												<NativeSelectOption key={profile} value={profile}>
													{profileLabels()[profile]}
												</NativeSelectOption>
											))}
										</field.SelectField>
									)}
								</form.AppField>
							)}
							{(action === "load-cpu" || action === "load-gpu") && (
								<form.AppField name="duration">
									{(field) => (
										<field.SelectField
											label={m.developer_duration()}
											className="w-full"
										>
											{Object.entries(durationLabels()).map(
												([seconds, label]) => (
													<NativeSelectOption key={seconds} value={seconds}>
														{label}
													</NativeSelectOption>
												),
											)}
										</field.SelectField>
									)}
								</form.AppField>
							)}
							{action === "move" && (
								<form.Field name="discard">
									{(field) => (
										<Label className="flex items-start gap-2 text-xs leading-relaxed">
											<Checkbox
												checked={field.state.value}
												onCheckedChange={(value) =>
													field.handleChange(value === true)
												}
											/>
											{m.developer_discard()}
										</Label>
									)}
								</form.Field>
							)}
							{invalid && (
								<p role="alert" className="text-xs text-destructive">
									{m.developer_input_error()}
								</p>
							)}
							{mutation.message && (
								<p role="alert" className="text-xs text-destructive">
									{m.developer_error()}
								</p>
							)}
							<div className="border-t pt-4">
								<Button
									type="submit"
									className="w-full"
									disabled={blocked}
									pending={mutation.pending}
									pendingLabel={m.developer_queueing()}
									variant={action === "destroy" ? "destructive" : "default"}
								>
									{m.developer_run()}
									<ArrowUpRightIcon aria-hidden="true" />
								</Button>
							</div>
						</>
					)}
				</form.Subscribe>
			</form>
			<WorkflowConfirmation
				input={confirmation}
				pending={mutation.pending}
				blocked={blocked}
				error={!!mutation.message}
				onClose={() => setConfirmation(null)}
				onConfirm={(input) => {
					void run(input);
				}}
			/>
		</>
	);
}
