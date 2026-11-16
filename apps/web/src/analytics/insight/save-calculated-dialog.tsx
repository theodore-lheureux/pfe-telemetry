import { m } from "@recount/i18n/messages";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { DialogActions } from "../../components/dialog-actions";
import { FormFeedback } from "../../components/form-feedback";
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useAppMutation } from "../../components/use-app-mutation";
import type { ProjectReference } from "../../organizations/contracts";
import { calculationFromDraft } from "../calculated-draft";
import {
	CALCULATED_UNITS,
	type CalculatedMetric,
	type CalculatedUnit,
	calculatedReference,
	type SaveCalculatedInput,
} from "../calculated-metrics";
import { saveCalculatedMetric } from "../calculated-metrics.functions";
import type { InsightDraft } from "./draft";

const UNIT_LABEL = {
	"1": m.insight_unit_none,
	"%": m.insight_unit_percent,
	By: m.insight_unit_bytes,
	s: m.insight_unit_seconds,
};

export function SaveCalculatedDialog({
	userId,
	reference,
	draft,
	index,
	existing,
	onClose,
}: {
	userId: string;
	reference: ProjectReference;
	draft: InsightDraft;
	index: number;
	existing?: CalculatedMetric;
	onClose: () => void;
}) {
	const id = useId();
	const queryClient = useQueryClient();
	const [identifier] = useState(() => existing?.id ?? crypto.randomUUID());
	const [name, setName] = useState(
		existing?.name ?? draft.formulas[index]?.name ?? "",
	);
	const [description, setDescription] = useState(existing?.description ?? "");
	const [unit, setUnit] = useState<CalculatedUnit>(
		() => existing?.unit ?? (draft.display.unit === "percent" ? "%" : "1"),
	);
	const mutation = useAppMutation({
		userId,
		saved: m.calculated_saved(),
		save: (data: SaveCalculatedInput, signal) =>
			saveCalculatedMetric({ data, signal }),
	});
	const definition = calculationFromDraft(draft, index, unit);
	const save = async () => {
		if (!definition) return;
		const result = await mutation.submit({
			...reference,
			id: identifier,
			create: existing === undefined,
			name: name.trim(),
			description,
			definition,
		});
		if (!result || result.error) return;
		const refreshed = await result.refresh(async (navigate) => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["analytics-catalog", userId, reference.projectId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["analytics-query", userId, reference.projectId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["attribute-values", userId, reference.projectId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["metric-attributes", userId, reference.projectId],
				}),
				queryClient.invalidateQueries({
					queryKey: [
						"metric-definition-attributes",
						userId,
						reference.projectId,
					],
				}),
			]);
			await navigate({
				to: "/organizations/$organizationId/projects/$projectId/definitions/metrics/$metric",
				params: { ...reference, metric: calculatedReference(result.data.id) },
			});
		}, m.calculated_saved());
		if (refreshed) onClose();
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !mutation.pending) onClose();
			}}
		>
			<DialogContent
				className="max-h-[calc(100svh-4rem)] overflow-y-auto sm:max-w-lg"
				showCloseButton={!mutation.pending}
			>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{existing ? m.calculated_save() : m.calculated_save_as()}
						</DialogTitle>
						<DialogDescription>
							{existing
								? m.calculated_edit_warning()
								: m.calculated_save_description()}
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-name`}>{m.name()}</Label>
						<Input
							id={`${id}-name`}
							value={name}
							required
							maxLength={120}
							disabled={mutation.pending}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-description`}>
							{m.definitions_description_label()}
						</Label>
						<Textarea
							id={`${id}-description`}
							value={description}
							maxLength={1000}
							disabled={mutation.pending}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-unit`}>{m.definitions_unit()}</Label>
						<Select
							value={unit}
							disabled={mutation.pending}
							onValueChange={(value) => setUnit(value as CalculatedUnit)}
						>
							<SelectTrigger id={`${id}-unit`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectGroup>
									{CALCULATED_UNITS.map((value) => (
										<SelectItem key={value} value={value}>
											{UNIT_LABEL[value]()}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
					<FormFeedback
						message={mutation.message}
						kind={mutation.kind}
						reserveLine={false}
					/>
					<DialogActions
						cancel={{
							label: m.cancel(),
							disabled: mutation.pending,
							onClick: onClose,
						}}
					>
						<Button
							type="submit"
							disabled={mutation.disabled || !name.trim() || !definition}
							pending={mutation.pending}
						>
							{m.saved_save()}
						</Button>
					</DialogActions>
				</form>
			</DialogContent>
		</Dialog>
	);
}
