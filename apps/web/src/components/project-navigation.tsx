import { m } from "@recount/i18n/messages";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
	BookmarkIcon,
	BookOpenIcon,
	LayoutDashboardIcon,
	ListIcon,
	type LucideIcon,
	PanelsTopLeftIcon,
	RadioIcon,
	ServerIcon,
	TelescopeIcon,
} from "lucide-react";
import type { ProjectReference } from "../organizations/contracts";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "./ui/sidebar";

type ProjectPath =
	| "/organizations/$organizationId/projects/$projectId"
	| "/organizations/$organizationId/projects/$projectId/dashboards"
	| "/organizations/$organizationId/projects/$projectId/explore"
	| "/organizations/$organizationId/projects/$projectId/insights"
	| "/organizations/$organizationId/projects/$projectId/activity"
	| "/organizations/$organizationId/projects/$projectId/nodes"
	| "/organizations/$organizationId/projects/$projectId/definitions"
	| "/organizations/$organizationId/projects/$projectId/executions";

interface Entry {
	to: ProjectPath;
	icon: LucideIcon;
	label: () => string;
	/** Active only on this exact page, not the pages below it. */
	exact?: boolean;
}

const GROUPS: { label?: () => string; entries: Entry[] }[] = [
	{
		entries: [
			{
				to: "/organizations/$organizationId/projects/$projectId",
				icon: LayoutDashboardIcon,
				label: m.overview,
				exact: true,
			},
			{
				to: "/organizations/$organizationId/projects/$projectId/dashboards",
				icon: PanelsTopLeftIcon,
				label: m.dashboards,
			},
			{
				to: "/organizations/$organizationId/projects/$projectId/explore",
				icon: TelescopeIcon,
				label: m.insight_tab_explore,
			},
			{
				to: "/organizations/$organizationId/projects/$projectId/insights",
				icon: BookmarkIcon,
				label: m.insights,
			},
		],
	},
	{
		label: m.nav_data,
		entries: [
			{
				to: "/organizations/$organizationId/projects/$projectId/activity",
				icon: RadioIcon,
				label: m.activity_title,
			},
			{
				to: "/organizations/$organizationId/projects/$projectId/nodes",
				icon: ServerIcon,
				label: m.nodes,
			},
			{
				to: "/organizations/$organizationId/projects/$projectId/definitions",
				icon: BookOpenIcon,
				label: m.definitions,
			},
		],
	},
	{
		label: m.nav_runs,
		entries: [
			{
				to: "/organizations/$organizationId/projects/$projectId/executions",
				icon: ListIcon,
				label: m.executions,
			},
		],
	},
];

/** The project's pages, grouped by what they are for. */
export function ProjectNavigation({
	reference,
	onNavigate,
}: {
	reference: ProjectReference;
	onNavigate: () => void;
}) {
	const matchRoute = useMatchRoute();
	return (
		<nav aria-label={m.project_navigation()}>
			{GROUPS.map((group) => (
				<SidebarGroup key={group.entries[0].to} className="p-1.5 pt-1">
					{group.label && (
						<SidebarGroupLabel>{group.label()}</SidebarGroupLabel>
					)}
					<SidebarMenu>
						{group.entries.map((entry) => (
							<SidebarMenuItem key={entry.to}>
								<SidebarMenuButton
									asChild
									tooltip={entry.label()}
									isActive={
										!!matchRoute({
											to: entry.to,
											params: reference,
											fuzzy: !entry.exact,
										})
									}
								>
									<Link to={entry.to} params={reference} onClick={onNavigate}>
										<entry.icon aria-hidden="true" />
										<span>{entry.label()}</span>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
			))}
		</nav>
	);
}
