import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";
import { useRef, useState } from "react";
import { AlertDialogActions } from "../../components/dialog-actions";
import { FormFeedback } from "../../components/form-feedback";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useAppMutation } from "../../components/use-app-mutation";
import type { ProjectReference } from "../../organizations/contracts";
import { deleteSavedInsights, saveInsight } from "../analytics.functions";
import { MAX_INSIGHT_NAME, type SavedInsight } from "../saved-insights";
import { InsightNameDialog } from "./name-dialog";

type Action =
	| { kind: "rename"; insight: SavedInsight }
	| { kind: "delete"; insights: SavedInsight[] };

type Change =
	| { kind: "rename"; insight: SavedInsight; name: string }
	| { kind: "duplicate"; insight: SavedInsight }
	| { kind: "delete"; insights: SavedInsight[] };

function changed(change: Change) {
	switch (change.kind) {
		case "rename":
			return m.saved_renamed();
		case "duplicate":
			return m.saved_duplicated();
		case "delete":
			return change.insights.length === 1
				? m.saved_deleted_one()
				: m.saved_deleted_many({ count: change.insights.length });
	}
}

/**
 * The menu on each saved insight and the dialogs it opens. One dialog serves every
 * row, and focus returns to the menu button that opened it.
 */
export function useInsightActions(
	userId: string,
	reference: ProjectReference,
	canWrite: boolean,
	/** After a deletion, such as clearing the rows that were selected. */
	onDeleted?: () => void,
) {
	// Results differ by change; the list reloads afterwards, so none is read.
	const mutation = useAppMutation<Change, unknown>({
		userId,
		saved: changed,
		transientNotice: true,
		save: (change: Change, signal) => {
			switch (change.kind) {
				case "rename":
					return saveInsight({
						data: {
							...reference,
							insightId: change.insight.id,
							name: change.name,
						},
						signal,
					});
				case "duplicate":
					return saveInsight({
						data: {
							...reference,
							insightId: crypto.randomUUID(),
							name: m
								.saved_copy_name({ name: change.insight.name })
								.slice(0, MAX_INSIGHT_NAME),
							description: change.insight.description,
							draft: change.insight.draft,
						},
						signal,
					});
				case "delete":
					return deleteSavedInsights({
						data: {
							...reference,
							insightIds: change.insights.map((insight) => insight.id),
						},
						signal,
					});
			}
		},
	});
	const pending = mutation.pending;
	const error = mutation.kind === "success" ? "" : mutation.message;
	const apply = async (change: Change, after?: () => void) => {
		const result = await mutation.submit(change);
		if (result && !result.error && (await result.refresh())) after?.();
	};
	const [action, setAction] = useState<Action | null>(null);
	const trigger = useRef<HTMLElement | null>(null);
	const open = (next: Action) => {
		trigger.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		mutation.clearMessage();
		setAction(next);
	};
	const close = () => setAction(null);
	const deleting = action?.kind === "delete" ? action.insights : [];
	const restoreFocus = (event: Event) => {
		if (trigger.current?.isConnected) {
			event.preventDefault();
			trigger.current.focus();
		}
	};

	function menu(insight: SavedInsight) {
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={m.saved_actions({ name: insight.name })}
					>
						<MoreHorizontalIcon aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem asChild>
						<Link
							to="/organizations/$organizationId/projects/$projectId/insights/explore"
							params={reference}
							search={{ insight: insight.id }}
						>
							{m.saved_open()}
						</Link>
					</DropdownMenuItem>
					{canWrite && (
						<>
							<DropdownMenuItem
								onSelect={() => open({ kind: "rename", insight })}
							>
								{m.saved_rename()}
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={pending}
								onSelect={() => void apply({ kind: "duplicate", insight })}
							>
								{m.saved_duplicate()}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onSelect={() => open({ kind: "delete", insights: [insight] })}
							>
								{m.saved_delete()}
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		);
	}

	const dialogs = (
		<>
			<InsightNameDialog
				open={action?.kind === "rename"}
				title={m.saved_rename_title()}
				initialName={action?.kind === "rename" ? action.insight.name : ""}
				pending={pending}
				error={error}
				onClose={close}
				onSubmit={(name) => {
					if (action?.kind !== "rename") return;
					void apply({ kind: "rename", insight: action.insight, name }, close);
				}}
			/>
			<AlertDialog
				open={action?.kind === "delete"}
				onOpenChange={(next) => {
					if (!next && !pending) close();
				}}
			>
				<AlertDialogContent onCloseAutoFocus={restoreFocus}>
					<AlertDialogTitle>
						{deleting.length === 1
							? m.saved_delete_title({ name: deleting[0].name })
							: m.saved_delete_many_title({ count: deleting.length })}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{m.saved_delete_description()}
					</AlertDialogDescription>
					<FormFeedback message={error} kind="error" reserveLine={false} />
					<AlertDialogActions
						cancel={{ label: m.cancel(), disabled: pending, onClick: close }}
					>
						<Button
							variant="destructive"
							disabled={pending}
							pending={pending}
							pendingLabel={m.saved_deleting()}
							onClick={() =>
								void apply({ kind: "delete", insights: deleting }, () => {
									close();
									onDeleted?.();
								})
							}
						>
							{m.saved_delete()}
						</Button>
					</AlertDialogActions>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);

	return {
		menu,
		dialogs,
		error: action ? "" : error,
		confirmDelete: (insights: SavedInsight[]) =>
			open({ kind: "delete", insights }),
	};
}
