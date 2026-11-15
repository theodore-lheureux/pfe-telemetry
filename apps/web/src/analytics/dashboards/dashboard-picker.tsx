import { m } from "@recount/i18n/messages";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../../components/ui/command";
import { unwrapOperation } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import type { DashboardSummary } from "../dashboards";
import { listDashboards } from "../dashboards.functions";

/** The project's dashboards, cached briefly, as every picker shares them. */
export function dashboardsQuery(userId: string, reference: ProjectReference) {
	return {
		queryKey: ["dashboards", userId, reference.projectId],
		queryFn: async ({ signal }: { signal: AbortSignal }) =>
			unwrapOperation(await listDashboards({ data: reference, signal })),
		staleTime: 30_000,
	};
}

/** A dashboard of the project, picked from a searchable list. */
export function DashboardPicker({
	userId,
	reference,
	exclude,
	selected,
	onPick,
	children,
}: {
	userId: string;
	reference: ProjectReference;
	/** A dashboard left out of the list, such as the one a tile is on. */
	exclude?: string;
	/** The current choice, marked with a check. */
	selected?: string | null;
	onPick: (dashboard: DashboardSummary) => void;
	/** `CommandItem`s listed before the dashboards, such as a default choice. */
	children?: ReactNode;
}) {
	const dashboards = useQuery(dashboardsQuery(userId, reference));
	const shown = (dashboards.data ?? []).filter(
		(dashboard) => dashboard.id !== exclude,
	);
	return (
		<Command
			className="w-72"
			// Typing searches here instead of jumping between menu items.
			onKeyDown={(event) => {
				if (event.key !== "Escape") event.stopPropagation();
			}}
		>
			<CommandInput placeholder={m.tile_search_dashboards()} autoFocus />
			<CommandList>
				<CommandEmpty>
					{dashboards.isPending
						? m.activity_attribute_loading()
						: m.tile_no_dashboards()}
				</CommandEmpty>
				<CommandGroup>
					{children}
					{shown.map((dashboard) => (
						<CommandItem
							key={dashboard.id}
							value={`${dashboard.name} ${dashboard.id}`}
							data-checked={dashboard.id === selected}
							onSelect={() => onPick(dashboard)}
						>
							<span className="truncate">{dashboard.name}</span>
						</CommandItem>
					))}
				</CommandGroup>
			</CommandList>
		</Command>
	);
}
