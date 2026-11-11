import { m } from "@recount/i18n/messages";
import {
	Link,
	useHydrated,
	useMatch,
	useMatchRoute,
} from "@tanstack/react-router";
import { LineChartIcon, ListIcon, RadioIcon, SettingsIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { rememberWorkspacePreference } from "../organizations/workspace-preference";
import type { ApplicationUser } from "./identity-avatar";
import { PasskeyEnrollmentPrompt } from "./passkey-enrollment-prompt";
import { settingsSearch } from "./settings-links";
import { ProjectTimeDisplayProvider } from "./time-display";
import { Button } from "./ui/button";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "./ui/resizable";
import { SheetClose } from "./ui/sheet";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarSeparator,
	SidebarTrigger,
	useSidebar,
} from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";
import { WorkspaceMenu } from "./workspace-menu";

export function AppShell({
	children,
	user,
}: {
	children: ReactNode;
	user: ApplicationUser;
}) {
	return (
		<TooltipProvider>
			<SidebarProvider
				defaultOpen
				className="h-svh min-h-0 overflow-hidden bg-muted"
				style={{ "--sidebar-width": "12.5rem" } as CSSProperties}
			>
				<AppShellContent user={user}>{children}</AppShellContent>
			</SidebarProvider>
		</TooltipProvider>
	);
}

function AppShellContent({
	children,
	user,
}: {
	children: ReactNode;
	user: ApplicationUser;
}) {
	const hydrated = useHydrated();
	const { isMobile, open, setOpen, setOpenMobile } = useSidebar();
	const panelRef = usePanelRef();
	const [width, setWidth] = useState(200);
	useEffect(() => {
		if (isMobile) return;
		if (open && panelRef.current?.isCollapsed()) panelRef.current.expand();
		else if (!open && !panelRef.current?.isCollapsed())
			panelRef.current?.collapse();
	}, [open, isMobile, panelRef]);
	const matchRoute = useMatchRoute();
	const workspace = useMatch({ from: "/_app/_workspace", shouldThrow: false });
	const organizationMatch = useMatch({
		from: "/_app/_workspace/organizations/$organizationId",
		shouldThrow: false,
	});
	const projectMatch = useMatch({
		from: "/_app/_workspace/organizations/$organizationId/projects/$projectId",
		shouldThrow: false,
	});
	const settingsMatch = useMatch({
		from: "/_app/_workspace/settings",
		shouldThrow: false,
	});
	const settings =
		workspace?.status === "success" && settingsMatch?.status === "success"
			? settingsMatch
			: undefined;
	const organization = settings
		? settings.context.settingsOrganization
		: organizationMatch?.status === "success"
			? organizationMatch.context.organization
			: workspace?.context.workspaceOrganization;
	const project = settings
		? (settings.context.settingsProject ?? workspace?.context.workspaceProject)
		: projectMatch?.status === "success"
			? projectMatch.context.project
			: workspace?.context.workspaceProject;
	const projects = settings
		? settings.context.settingsProjects
		: organizationMatch?.status === "success"
			? organizationMatch.context.projects
			: (workspace?.context.workspaceProjects ?? []);
	const organizations =
		workspace?.status === "success" ? workspace.context.organizations : [];
	const selection = {
		organizationId: organization?.id,
		projectId: project?.id,
	};
	const retainedOrganizationId = project?.organizationId;
	const retainedProjectId = project?.id;
	useEffect(() => {
		if (!retainedOrganizationId || !retainedProjectId) return;
		rememberWorkspacePreference(user.id, {
			organizationId: retainedOrganizationId,
			id: retainedProjectId,
		});
	}, [retainedOrganizationId, retainedProjectId, user.id]);
	return (
		<ProjectTimeDisplayProvider project={project}>
			<ResizablePanelGroup
				orientation="horizontal"
				disabled={isMobile || !hydrated}
				className="group/shell max-md:[&>[data-panel]:first-child]:hidden!"
				style={{ "--sidebar-width": `${width}px` } as CSSProperties}
			>
				<ResizablePanel
					id="navigation"
					panelRef={panelRef}
					defaultSize={200}
					minSize={isMobile ? 0 : 200}
					maxSize={isMobile ? 0 : 360}
					collapsedSize={isMobile ? 0 : 48}
					collapsible
					groupResizeBehavior="preserve-pixel-size"
					className="[&_[data-slot=sidebar-gap]]:hidden"
					onResize={({ inPixels }) => {
						if (isMobile || inPixels === 0) return;
						setWidth(inPixels);
						const expanded = inPixels > 49;
						if (expanded !== open) setOpen(expanded);
					}}
				>
					<Sidebar
						collapsible="icon"
						className="transition-none group-data-[side=left]:border-r-0 group-data-[side=right]:border-l-0 [&_[data-slot=sidebar-inner]]:bg-muted"
						aria-label={m.project_navigation()}
					>
						<SidebarHeader className="gap-0 p-1.5">
							<WorkspaceMenu
								user={user}
								onNavigate={() => setOpenMobile(false)}
								selection={{
									organization,
									project,
									projects,
									organizations,
									settingsSection: settings?.search.section,
								}}
							/>
						</SidebarHeader>
						<SidebarContent className="group-data-[collapsible=icon]:overflow-y-auto">
							<SidebarGroup className="p-1.5 pt-1">
								<nav aria-label={m.project_navigation()}>
									<SidebarMenu>
										{project && (
											<>
												<SidebarMenuItem>
													<SidebarMenuButton
														asChild
														tooltip={m.activity_title()}
														isActive={
															!!matchRoute({
																to: "/organizations/$organizationId/projects/$projectId/activity",
																params: {
																	organizationId: project.organizationId,
																	projectId: project.id,
																},
																fuzzy: true,
															})
														}
													>
														<Link
															to="/organizations/$organizationId/projects/$projectId/activity"
															params={{
																organizationId: project.organizationId,
																projectId: project.id,
															}}
															onClick={() => setOpenMobile(false)}
														>
															<RadioIcon aria-hidden="true" />
															<span>{m.activity_title()}</span>
														</Link>
													</SidebarMenuButton>
												</SidebarMenuItem>
												<SidebarMenuItem>
													<SidebarMenuButton
														asChild
														tooltip={m.insights()}
														isActive={
															!!matchRoute({
																to: "/organizations/$organizationId/projects/$projectId/insights",
																params: {
																	organizationId: project.organizationId,
																	projectId: project.id,
																},
																fuzzy: true,
															})
														}
													>
														<Link
															to="/organizations/$organizationId/projects/$projectId/insights"
															params={{
																organizationId: project.organizationId,
																projectId: project.id,
															}}
															onClick={() => setOpenMobile(false)}
														>
															<LineChartIcon aria-hidden="true" />
															<span>{m.insights()}</span>
														</Link>
													</SidebarMenuButton>
												</SidebarMenuItem>
												<SidebarMenuItem>
													<SidebarMenuButton
														asChild
														tooltip={m.executions()}
														isActive={
															!!matchRoute({
																to: "/organizations/$organizationId/projects/$projectId/executions",
																params: {
																	organizationId: project.organizationId,
																	projectId: project.id,
																},
																fuzzy: true,
															})
														}
													>
														<Link
															to="/organizations/$organizationId/projects/$projectId/executions"
															params={{
																organizationId: project.organizationId,
																projectId: project.id,
															}}
															activeProps={{ className: "active" }}
															onClick={() => setOpenMobile(false)}
														>
															<ListIcon aria-hidden="true" />
															<span>{m.executions()}</span>
														</Link>
													</SidebarMenuButton>
												</SidebarMenuItem>
											</>
										)}
									</SidebarMenu>
								</nav>
							</SidebarGroup>
						</SidebarContent>
						<SidebarSeparator className="mx-2" />
						<SidebarFooter className="gap-1 p-1.5">
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										tooltip={m.settings()}
										isActive={!!settings}
									>
										<Link
											to="/settings"
											search={settingsSearch(
												project
													? "project"
													: organization
														? "organization"
														: "user",
												selection,
											)}
											activeOptions={{ includeSearch: false }}
											onClick={() => setOpenMobile(false)}
										>
											<SettingsIcon aria-hidden="true" />
											<span>{m.settings()}</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
							{isMobile && (
								<SheetClose asChild>
									<Button variant="outline">{m.close()}</Button>
								</SheetClose>
							)}
						</SidebarFooter>
					</Sidebar>
				</ResizablePanel>
				<ResizableHandle
					data-sidebar-resize=""
					aria-label={m.project_navigation()}
					className="z-20 hidden w-0 bg-transparent focus-visible:ring-0 after:inset-y-1 after:w-3 md:flex"
				/>
				<ResizablePanel id="content" minSize={0} className="flex min-w-0">
					<SidebarInset
						id="main-content"
						tabIndex={-1}
						className="min-h-0 min-w-0 overflow-y-auto bg-background transition-[border-color,box-shadow] focus-visible:outline-none md:my-1 md:mr-1 md:rounded-lg md:border md:group-has-[[data-sidebar-resize]:hover]/shell:border-l-sidebar-ring md:group-has-[[data-sidebar-resize]:hover]/shell:shadow-[inset_2px_0_0_var(--sidebar-ring)] md:group-has-[[data-sidebar-resize][data-separator=active]]/shell:border-l-sidebar-ring md:group-has-[[data-sidebar-resize][data-separator=active]]/shell:shadow-[inset_2px_0_0_var(--sidebar-ring)] md:group-has-[[data-sidebar-resize]:focus-visible]/shell:border-l-sidebar-ring md:group-has-[[data-sidebar-resize]:focus-visible]/shell:shadow-[inset_2px_0_0_var(--sidebar-ring)]"
					>
						{isMobile && (
							<SidebarTrigger
								aria-label={m.open_navigation()}
								disabled={!hydrated}
								className="fixed top-3 left-3 z-30 border bg-card shadow-sm"
							/>
						)}
						<div className="flex min-w-0 flex-col gap-6 p-4 pt-14 md:p-6">
							<PasskeyEnrollmentPrompt />
							{children}
						</div>
					</SidebarInset>
				</ResizablePanel>
			</ResizablePanelGroup>
		</ProjectTimeDisplayProvider>
	);
}
