import { m } from "@recount/i18n/messages";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DialogActions } from "../../components/dialog-actions";
import { FormFeedback } from "../../components/form-feedback";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../../components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/skeleton";
import { operationMessage } from "../../lib/operation-message";
import { MutationFailure, unwrapOperation } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import { listSavedInsights } from "../analytics.functions";
import { MAX_DASHBOARD_TILES } from "../dashboards";
import { decodeDraft } from "../insight/draft";
import { DISPLAY_ICON } from "../insight/labels";

/** Chooses saved insights to add to a dashboard, searching them by name or tag. */
export function AddTilesDialog({
	open,
	userId,
	reference,
	room,
	pending,
	error,
	onClose,
	onAdd,
}: {
	open: boolean;
	userId: string;
	reference: ProjectReference;
	/** How many more tiles the dashboard can hold. */
	room: number;
	pending: boolean;
	error: string;
	onClose: () => void;
	onAdd: (insightIds: string[]) => void;
}) {
	const [chosen, setChosen] = useState<string[]>([]);
	useEffect(() => {
		if (open) setChosen([]);
	}, [open]);
	const insights = useQuery({
		queryKey: ["saved-insights", userId, reference.projectId],
		queryFn: async () =>
			unwrapOperation(await listSavedInsights({ data: reference })),
		enabled: open,
		staleTime: 0,
		gcTime: 0,
	});
	const toggle = (id: string) =>
		setChosen((current) => {
			if (current.includes(id)) return current.filter((entry) => entry !== id);
			return current.length < room ? [...current, id] : current;
		});
	const list = () => {
		if (insights.error)
			return (
				<FormFeedback
					kind="error"
					reserveLine={false}
					message={
						insights.error instanceof MutationFailure
							? operationMessage(insights.error.failure)
							: m.insight_unavailable()
					}
				/>
			);
		if (!insights.data) return <Skeleton className="h-64 w-full" />;
		if (!insights.data.length)
			return (
				<p className="text-sm text-muted-foreground">
					{m.dashboard_no_insights()}{" "}
					<Link
						to="/organizations/$organizationId/projects/$projectId/explore"
						params={reference}
						className="underline"
					>
						{m.saved_explore()}
					</Link>
				</p>
			);
		return (
			<Command className="rounded-md border">
				<CommandInput placeholder={m.saved_search()} />
				<CommandList className="max-h-72">
					<CommandEmpty>{m.saved_no_match()}</CommandEmpty>
					<CommandGroup>
						{insights.data.map((insight) => {
							const Icon =
								DISPLAY_ICON[decodeDraft(insight.draft).display.type];
							const selected = chosen.includes(insight.id);
							return (
								<CommandItem
									key={insight.id}
									value={`${insight.name} ${insight.tags.join(" ")} ${insight.id}`}
									disabled={!selected && chosen.length >= room}
									onSelect={() => toggle(insight.id)}
								>
									<Checkbox
										checked={selected}
										tabIndex={-1}
										aria-hidden="true"
										className="pointer-events-none"
									/>
									<Icon aria-hidden="true" />
									<span className="truncate">{insight.name}</span>
								</CommandItem>
							);
						})}
					</CommandGroup>
				</CommandList>
			</Command>
		);
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !pending) onClose();
			}}
		>
			<DialogContent className="sm:max-w-lg" showCloseButton={!pending}>
				<DialogHeader>
					<DialogTitle>{m.dashboard_add_insights()}</DialogTitle>
					{room < MAX_DASHBOARD_TILES && (
						<DialogDescription>
							{m.dashboard_room({ count: room })}
						</DialogDescription>
					)}
				</DialogHeader>
				{list()}
				<FormFeedback message={error} kind="error" reserveLine={false} />
				<DialogActions
					cancel={{ label: m.cancel(), disabled: pending, onClick: onClose }}
				>
					<Button
						disabled={pending || !chosen.length}
						pending={pending}
						pendingLabel={m.saving()}
						onClick={() => onAdd(chosen)}
					>
						{chosen.length > 1
							? m.dashboard_add_many({ count: chosen.length })
							: m.dashboard_add()}
					</Button>
				</DialogActions>
			</DialogContent>
		</Dialog>
	);
}
