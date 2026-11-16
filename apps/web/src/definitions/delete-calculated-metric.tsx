import { m } from "@recount/i18n/messages";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import type {
	CalculatedMetric,
	DeleteCalculatedInput,
} from "../analytics/calculated-metrics";
import { deleteCalculatedMetric } from "../analytics/calculated-metrics.functions";
import { AlertDialogActions } from "../components/dialog-actions";
import { FormFeedback } from "../components/form-feedback";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../components/ui/tooltip";
import { useAppMutation } from "../components/use-app-mutation";
import { operationMessage } from "../lib/operation-message";
import type { ProjectReference } from "../organizations/contracts";

export function DeleteCalculatedMetric({
	userId,
	reference,
	definition,
	used,
}: {
	userId: string;
	reference: ProjectReference;
	definition: CalculatedMetric;
	used: boolean;
}) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const mutation = useAppMutation({
		userId,
		saved: m.calculated_deleted(),
		save: (data: DeleteCalculatedInput, signal) =>
			deleteCalculatedMetric({ data, signal }),
		errorMessage: (failure) =>
			failure.code === "CONFLICT"
				? m.calculated_delete_in_use()
				: operationMessage(failure),
	});
	const remove = async () => {
		const result = await mutation.submit({ ...reference, id: definition.id });
		if (!result || result.error) return;
		for (const prefix of [
			"analytics-catalog",
			"analytics-query",
			"metric-attributes",
			"metric-definition-attributes",
			"attribute-values",
		])
			void queryClient.invalidateQueries({
				queryKey: [prefix, userId, reference.projectId],
				refetchType: "none",
			});
		setOpen(false);
		// The deleted definition cannot reload; leave it for the metrics list.
		await navigate({
			to: "/organizations/$organizationId/projects/$projectId/definitions",
			params: reference,
		});
	};
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!mutation.pending) setOpen(next);
			}}
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex">
						<AlertDialogTrigger asChild>
							<Button
								variant="destructive"
								disabled={used || mutation.disabled}
								onClick={() => {
									mutation.clearMessage();
								}}
							>
								<Trash2Icon aria-hidden="true" />
								{m.saved_delete()}
							</Button>
						</AlertDialogTrigger>
					</span>
				</TooltipTrigger>
				<TooltipContent>
					{used ? m.calculated_delete_in_use() : m.saved_delete()}
				</TooltipContent>
			</Tooltip>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{m.saved_delete_title({ name: definition.name })}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{m.calculated_delete_description()}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<FormFeedback
					message={mutation.kind === "success" ? "" : mutation.message}
					kind={mutation.kind}
					reserveLine={false}
				/>
				<AlertDialogActions
					cancel={{ label: m.cancel(), disabled: mutation.pending }}
				>
					<Button
						variant="destructive"
						disabled={mutation.disabled}
						pending={mutation.pending}
						pendingLabel={m.saved_deleting()}
						onClick={() => void remove()}
					>
						{m.saved_delete()}
					</Button>
				</AlertDialogActions>
			</AlertDialogContent>
		</AlertDialog>
	);
}
