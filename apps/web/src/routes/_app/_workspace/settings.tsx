import { m } from "@recount/i18n/messages";
import {
	createFileRoute,
	isNotFound,
	notFound,
	SearchParamError,
	useLocation,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
	listEnrollmentKeys,
	listNodes,
} from "@/collectors/collector.functions";
import { AppearancePreferences } from "@/components/appearance-settings";
import { OrganizationInvitations } from "@/components/organization-invitations";
import { OrganizationMembers } from "@/components/organization-members";
import { ProjectGrants } from "@/components/project-grants";
import { twoFactorFeature } from "@/components/settings/authentication-features";
import { CollectorsSettings } from "@/components/settings/collectors-settings";
import {
	OrganizationDeletion,
	ProjectDangerZone,
} from "@/components/settings/danger-settings";
import { OrganizationAuthentication } from "@/components/settings/organization-authentication";
import { OrganizationSettings } from "@/components/settings/organization-settings";
import { PlannedSetting } from "@/components/settings/planned-setting";
import {
	ProjectCustomization,
	ProjectSettings,
} from "@/components/settings/project-settings";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { UserProfile } from "@/components/settings/user-profile";
import {
	parseSettingsSearch,
	settingsScopes,
} from "@/components/settings-links";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "@/organizations/contracts";
import { listInvitations } from "@/organizations/invitation.functions";
import {
	listOrganizationMembers,
	listProjectGrantCandidates,
} from "@/organizations/member.functions";
import {
	getOrganization,
	getProject,
	listProjectMembers,
	listProjects,
} from "@/organizations/organization.functions";
import { routeData } from "@/organizations/route-data";
import { SettingsPageHeading } from "../../../components/settings/settings-page-heading";

export const Route = createFileRoute("/_app/_workspace/settings")({
	validateSearch: parseSettingsSearch,
	onError: (error) => {
		// Router wraps search validation failures; malformed scopes remain not-found.
		if (error instanceof SearchParamError && isNotFound(error.cause))
			throw error.cause;
	},
	beforeLoad: async ({ search, location, context }) => {
		let organization: OrganizationSummary | undefined =
			context.workspaceOrganization;
		let project: ProjectSummary | undefined = context.workspaceProject;
		let projects: ProjectSummary[] = context.workspaceProjects;
		if (search.organizationId) {
			const data = { organizationId: search.organizationId };
			const [org, visibleProjects] = await Promise.all([
				getOrganization({ data }),
				listProjects({ data }),
			]);
			organization = routeData(org, location.href);
			projects = routeData(visibleProjects, location.href);
			if (search.projectId)
				project = routeData(
					await getProject({ data: { ...data, projectId: search.projectId } }),
					location.href,
				);
		}
		if (settingsScopes[search.section] === "project" && !project)
			throw notFound();
		if (settingsScopes[search.section] === "organization" && !organization)
			throw notFound();
		return {
			settingsOrganization: organization,
			settingsProject: project,
			settingsProjects: projects,
		};
	},
	loaderDeps: ({ search }) => search,
	loader: async ({ context, deps, location }) => {
		const project = context.settingsProject;
		const organization = context.settingsOrganization;
		if (deps.section === "collectors" && project) {
			if (project.role !== "admin") throw notFound();
			const reference = {
				organizationId: project.organizationId,
				projectId: project.id,
			};
			const [keys, nodes] = await Promise.all([
				listEnrollmentKeys({ data: reference }),
				listNodes({ data: { ...reference, status: "active", page: 1 } }),
			]);
			return {
				kind: "collectors" as const,
				enrollmentKeys: routeData(keys, location.href),
				nodes: routeData(nodes, location.href),
			};
		}
		if (deps.section === "project-members" && project) {
			const data = {
				organizationId: project.organizationId,
				projectId: project.id,
			};
			// Authorize the project administration read before loading grant candidates.
			const grants = routeData(
				await listProjectMembers({ data }),
				location.href,
			);
			const members = routeData(
				await listProjectGrantCandidates({ data }),
				location.href,
			);
			return { kind: "project-members" as const, grants, members };
		}
		if (deps.section === "organization-members" && organization) {
			const data = { organizationId: organization.id };
			const [members, invitations] = await Promise.all([
				listOrganizationMembers({ data }),
				organization.role !== "member" ? listInvitations({ data }) : null,
			]);
			return {
				kind: "organization-members" as const,
				members: routeData(members, location.href),
				invitations: invitations ? routeData(invitations, location.href) : null,
				asOf: Date.now(),
			};
		}
		return { kind: "basic" as const };
	},
	staleTime: 0,
	gcTime: 0,
	headers: () => ({ "Cache-Control": "private, no-store" }),
	head: () => ({ meta: [{ title: `${m.settings()} · ${m.app_title()}` }] }),
	component: Settings,
});

function Settings() {
	const {
		settingsOrganization: organization,
		settingsProject: project,
		settingsProjects: projects,
		user,
	} = Route.useRouteContext();
	const search = Route.useSearch();
	const loaded = Route.useLoaderData();
	const hash = useLocation({ select: (location) => location.hash });
	const locationKey = useLocation({
		select: (location) => location.state.__TSR_key,
	});
	const navigationStatus = useRouterState({ select: (state) => state.status });
	const focusedNavigation = useRef("");
	// The URL hash can arrive before the destination's fields have mounted.
	useEffect(() => {
		const navigation = `${locationKey}/${hash}`;
		if (
			!hash ||
			navigationStatus !== "idle" ||
			focusedNavigation.current === navigation
		)
			return;
		const target = document.getElementById(hash);
		if (!target) return;
		focusedNavigation.current = navigation;
		const details = target.closest("details");
		if (details) details.open = true;
		target.scrollIntoView({ block: "center" });
		if (
			target.matches(
				"input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
			)
		)
			target.focus({ preventScroll: true });
	}, [hash, locationKey, navigationStatus]);
	return (
		<div className="flex min-w-0 flex-col gap-6 lg:flex-row">
			<SettingsNavigation
				selection={search}
				organization={organization}
				project={project}
			/>
			<div
				className="flex min-w-0 flex-1 flex-col gap-6"
				key={`${user.id}/${search.organizationId ?? ""}/${search.projectId ?? ""}/${search.section}`}
			>
				{search.section === "project" && project && (
					<ProjectSettings project={project} />
				)}
				{search.section === "project-customization" && project && (
					<ProjectCustomization project={project} />
				)}
				{search.section === "project-danger" && project && (
					<ProjectDangerZone />
				)}
				{search.section === "organization-authentication" && organization && (
					<OrganizationAuthentication />
				)}
				{search.section === "organization-delete" && organization && (
					<OrganizationDeletion />
				)}
				{search.section === "organization" && organization && (
					<OrganizationSettings organization={organization} />
				)}
				{search.section === "user" && <UserProfile />}
				{search.section === "appearance" && <AppearancePreferences />}
				{search.section === "collectors" &&
					project &&
					loaded.kind === "collectors" && (
						<CollectorsSettings
							key={`${project.id}:${user.id}`}
							project={project}
							userId={user.id}
							enrollmentKeys={loaded.enrollmentKeys}
							initialNodes={loaded.nodes}
						/>
					)}
				{search.section === "project-members" &&
					project &&
					loaded.kind === "project-members" && (
						<ProjectGrants
							key={`${project.id}:${user.id}`}
							project={project}
							members={loaded.members}
							grants={loaded.grants}
							userId={user.id}
						/>
					)}
				{search.section === "organization-members" &&
					organization &&
					loaded.kind === "organization-members" && (
						<>
							<SettingsPageHeading />
							{loaded.invitations && (
								<OrganizationInvitations
									key={`invitations:${organization.id}:${user.id}`}
									organization={organization}
									invitations={loaded.invitations}
									members={loaded.members}
									asOf={loaded.asOf}
									userId={user.id}
								/>
							)}
							<OrganizationMembers
								key={`members:${organization.id}:${user.id}`}
								organization={organization}
								members={loaded.members}
								userId={user.id}
								projects={projects}
							/>
							<PlannedSetting feature={twoFactorFeature} />
						</>
					)}
			</div>
		</div>
	);
}
