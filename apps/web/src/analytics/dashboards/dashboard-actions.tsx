import { m } from "@recount/i18n/messages";
import { useNavigate } from "@tanstack/react-router";
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
import { deleteDashboard, saveDashboard } from "../dashboards.functions";
import { DashboardDialog } from "./dashboard-dialog";

const LIST =
	"/organizations/$organizationId/projects/$projectId/insights/dashboards" as const;

/** What the actions need of a dashboard, from the list or the open dashboard. */
interface Named {
	id: string;
	name: string;
	description: string;
}

type Action =
	| { kind: "create" }
	| { kind: "edit"; dashboard: Named }
	| { kind: "delete"; dashboard: Named };

type Change =
	| { kind: "create"; id: string; name: string; description: string }
	| { kind: "edit"; dashboard: Named; name: string; description: string }
	| { kind: "delete"; dashboard: Named };

function changed(change: Change) {
	if (change.kind === "create") return m.dashboard_created();
	if (change.kind === "delete") return m.dashboard_deleted();
	return m.changes_saved();
}

/**
 * Creating, editing and deleting dashboards, with the dialogs they open. A new
 * dashboard opens once created; deleting the open one returns to the list.
 */
export function useDashboardActions(
	userId: string,
	reference: ProjectReference,
	canWrite: boolean,
	/** The dashboard on screen, which a deletion leaves. */
	openId?: string,
) {
	const navigate = useNavigate();
	const mutation = useAppMutation<Change, unknown>({
		userId,
		saved: changed,
		transientNotice: true,
		save: (change, signal) => {
			if (change.kind === "delete")
				return deleteDashboard({
					data: { ...reference, dashboardId: change.dashboard.id },
					signal,
				});
			return saveDashboard({
				data: {
					...reference,
					dashboardId:
						change.kind === "create" ? change.id : change.dashboard.id,
					name: change.name,
					description: change.description,
				},
				signal,
			});
		},
	});
	const pending = mutation.pending;
	const error = mutation.kind === "success" ? "" : mutation.message;
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
	const apply = async (change: Change) => {
		const result = await mutation.submit(change);
		if (!result || result.error) return;
		// The deleted dashboard's page cannot reload, so it is left for the list instead.
		if (change.kind === "delete" && change.dashboard.id === openId) {
			close();
			await navigate({ to: LIST, params: reference });
			return;
		}
		const refreshed = await result.refresh(async (go) => {
			if (change.kind === "create")
				await go({
					to: `${LIST}/$dashboardId`,
					params: { ...reference, dashboardId: change.id },
				});
		});
		if (refreshed) close();
	};
	const restoreFocus = (event: Event) => {
		if (trigger.current?.isConnected) {
			event.preventDefault();
			trigger.current.focus();
		}
	};

	function menu(dashboard: Named) {
		if (!canWrite) return null;
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={m.dashboard_actions({ name: dashboard.name })}
					>
						<MoreHorizontalIcon aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onSelect={() => open({ kind: "edit", dashboard })}>
						{m.dashboard_edit()}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						onSelect={() => open({ kind: "delete", dashboard })}
					>
						{m.saved_delete()}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		);
	}

	const editing = action?.kind === "edit" ? action.dashboard : null;
	const deleting = action?.kind === "delete" ? action.dashboard : null;
	const dialogs = (
		<>
			<DashboardDialog
				open={action?.kind === "create" || action?.kind === "edit"}
				title={editing ? m.dashboard_edit_title() : m.dashboard_new()}
				initial={editing ?? { name: "", description: "" }}
				pending={pending}
				error={error}
				onClose={close}
				onSubmit={(value) =>
					void apply(
						editing
							? { kind: "edit", dashboard: editing, ...value }
							: { kind: "create", id: crypto.randomUUID(), ...value },
					)
				}
			/>
			<AlertDialog
				open={!!deleting}
				onOpenChange={(next) => {
					if (!next && !pending) close();
				}}
			>
				<AlertDialogContent onCloseAutoFocus={restoreFocus}>
					<AlertDialogTitle>
						{m.dashboard_delete_title({ name: deleting?.name ?? "" })}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{m.dashboard_delete_description()}
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
								deleting && void apply({ kind: "delete", dashboard: deleting })
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
		create: () => open({ kind: "create" }),
	};
}
