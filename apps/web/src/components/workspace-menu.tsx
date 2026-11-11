import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import {
	CheckIcon,
	ChevronDownIcon,
	LogOutIcon,
	PlusIcon,
	SettingsIcon,
} from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "../organizations/contracts";
import { rememberWorkspacePreference } from "../organizations/workspace-preference";
import { getWorkspaceSelection } from "../organizations/workspace-selection.functions";
import {
	type ApplicationUser,
	OrganizationAvatar,
	ProjectAvatar,
	UserAvatar,
} from "./identity-avatar";
import { useLocaleChangeBlocker } from "./locale-safety";
import { OrganizationInvitationPopup } from "./member-administration/invitation-dialog";
import { useMutationFeedback } from "./mutation-feedback";
import {
	type SettingsSection,
	settingsScopes,
	settingsSearch,
} from "./settings-links";
import { signOutOfApplication } from "./sign-out";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "./ui/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { usePageConfirmation } from "./use-page-confirmation";
import { WorkspaceCreationDialog } from "./workspace-creation-dialog";

export interface WorkspaceSelection {
	organizations: OrganizationSummary[];
	organization?: OrganizationSummary;
	project?: ProjectSummary;
	projects: ProjectSummary[];
	settingsSection?: SettingsSection;
}

export function WorkspaceMenu({
	user,
	selection,
	onNavigate,
}: {
	user: ApplicationUser;
	selection: WorkspaceSelection;
	onNavigate?: () => void;
}) {
	const { organization, project, organizations, projects, settingsSection } =
		selection;
	const selected = { organizationId: organization?.id, projectId: project?.id };
	const projectGroups = new Map<string, ProjectSummary[]>();
	for (const entry of projects) {
		const group = projectGroups.get(entry.projectGroup) ?? [];
		group.push(entry);
		projectGroups.set(entry.projectGroup, group);
	}
	const router = useRouter();
	const hydrated = useHydrated();
	const setFeedback = useMutationFeedback();
	const [open, setOpen] = useState(false);
	const choice = useRef(0);
	const [dialog, setDialog] = usePageConfirmation<
		"organization" | "project" | "invite"
	>();
	const authentication = router.options.context.authentication;
	const identity = useSyncExternalStore(
		authentication.subscribe,
		authentication.getSnapshot,
		authentication.getSnapshot,
	);
	const pending = identity.action === "signout";
	const [failure, setFailure] = useState("");
	useLocaleChangeBlocker(pending);
	async function logout() {
		setFailure("");
		try {
			setFailure(await signOutOfApplication(router, setFeedback));
		} catch {
			setFailure(m.signout_failed_please_try_again());
		}
	}
	async function chooseOrganization(organizationId: string) {
		const attempt = ++choice.current;
		const revision = authentication.getSnapshot().revision;
		const href = router.state.location.href;
		setOpen(false);
		onNavigate?.();
		const result = await getWorkspaceSelection({ data: { organizationId } });
		if (
			attempt !== choice.current ||
			revision !== authentication.getSnapshot().revision ||
			href !== router.state.location.href
		)
			return;
		if (result.error) {
			setFailure(m.the_action_was_not_completed_please_try_again());
			setOpen(true);
			return;
		}
		const projectId = result.data.project?.id;
		if (result.data.project)
			rememberWorkspacePreference(user.id, result.data.project);
		if (settingsSection)
			return router.navigate({
				to: "/settings",
				search: settingsSearch(
					settingsScopes[settingsSection] === "project" && !projectId
						? "organization"
						: settingsSection,
					{ organizationId, projectId },
				),
			});
		if (projectId)
			return router.navigate({
				to: "/organizations/$organizationId/projects/$projectId/executions",
				params: { organizationId, projectId },
			});
		return router.navigate({
			to: "/organizations/$organizationId",
			params: { organizationId },
		});
	}
	function chooseProject(projectId: string) {
		choice.current++;
		if (!organization) return;
		rememberWorkspacePreference(user.id, {
			id: projectId,
			organizationId: organization.id,
		});
		setOpen(false);
		onNavigate?.();
		if (settingsSection)
			return router.navigate({
				to: "/settings",
				search: settingsSearch(settingsSection, {
					organizationId: organization.id,
					projectId,
				}),
			});
		return router.navigate({
			to: "/organizations/$organizationId/projects/$projectId/executions",
			params: { organizationId: organization.id, projectId },
		});
	}
	return (
		<>
			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						disabled={!hydrated || pending}
						className="w-full min-w-0 justify-start gap-1.5 px-1 text-muted-foreground hover:text-foreground group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
						aria-label={m.switch_workspace()}
						title={
							organization
								? `${organization.name}${project ? ` / ${project.name}` : ""}`
								: m.organizations()
						}
					>
						<OrganizationAvatar
							organization={organization}
							className="size-5 text-[10px]"
						/>
						<span className="flex-1 truncate text-left group-data-[collapsible=icon]:hidden">
							{project?.name ?? organization?.name ?? m.organizations()}
						</span>
						<ChevronDownIcon
							aria-hidden="true"
							className="size-3 shrink-0 group-data-[collapsible=icon]:hidden"
						/>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					onCloseAutoFocus={(event) => {
						if (dialog) event.preventDefault();
					}}
					className="w-[max(250px,var(--radix-dropdown-menu-trigger-width))] max-w-[calc(100vw-2rem)] p-0"
					onClick={(event) => {
						if (
							event.target instanceof Element &&
							event.target.closest("a[href]")
						)
							onNavigate?.();
					}}
				>
					<Card className="gap-0 rounded-none bg-popover py-0 text-popover-foreground shadow-none ring-0">
						<CardContent className="p-1">
							<DropdownMenuGroup>
								<div className="flex items-center justify-between">
									<DropdownMenuLabel className="text-[11px] uppercase tracking-wide">
										{m.project()}
									</DropdownMenuLabel>
									{organization && organization.role !== "member" && (
										<DropdownMenuItem
											className="p-1"
											aria-label={m.create_project()}
											onSelect={() => {
												setOpen(false);
												setDialog("project");
											}}
										>
											<PlusIcon aria-hidden="true" className="size-4" />
										</DropdownMenuItem>
									)}
								</div>
								<DropdownMenuSeparator />
								<DropdownMenuSub>
									<DropdownMenuSubTrigger
										className="min-h-8 rounded-md"
										disabled={!organization}
										aria-label={m.choose_project()}
									>
										<ProjectAvatar
											name={project?.name ?? m.no_visible_projects()}
										/>
										<span className="truncate font-medium">
											{project?.name ?? m.no_visible_projects()}
										</span>
									</DropdownMenuSubTrigger>
									<DropdownMenuSubContent
										className="w-[min(20rem,calc(100vw-2rem))]"
										onFocus={(event) => {
											if (event.target === event.currentTarget)
												event.currentTarget.querySelector("input")?.focus();
										}}
									>
										<Command
											label={m.search_projects()}
											onKeyDown={(event) => event.stopPropagation()}
										>
											<CommandInput
												aria-label={m.search_projects()}
												placeholder={m.search_projects()}
											/>
											<CommandList>
												<CommandEmpty>{m.no_matching_choices()}</CommandEmpty>
												{[...projectGroups].map(([group, entries]) => (
													<CommandGroup
														key={group}
														heading={group || undefined}
													>
														{entries.map((entry) => (
															<CommandItem
																key={entry.id}
																value={`${entry.name} ${entry.id} ${entry.projectGroup} ${entry.tags.join(" ")}`}
																data-checked={entry.id === project?.id}
																aria-label={entry.name}
																className="min-h-8 rounded-md [&>svg:last-child]:hidden"
																onSelect={() => void chooseProject(entry.id)}
															>
																<CheckIcon
																	aria-hidden="true"
																	className={
																		entry.id === project?.id
																			? "size-4"
																			: "size-4 opacity-0"
																	}
																/>
																<ProjectAvatar name={entry.name} />
																<span className="truncate">{entry.name}</span>
															</CommandItem>
														))}
													</CommandGroup>
												))}
											</CommandList>
										</Command>
										{organization && organization.role !== "member" && (
											<>
												<DropdownMenuSeparator />
												<DropdownMenuItem
													className="min-h-9 rounded-md"
													onSelect={() => {
														setOpen(false);
														setDialog("project");
													}}
												>
													<PlusIcon aria-hidden="true" />
													{m.new_project()}
												</DropdownMenuItem>
											</>
										)}
									</DropdownMenuSubContent>
								</DropdownMenuSub>
								{organization && organization.role !== "member" && (
									<DropdownMenuItem
										className="min-h-8"
										onSelect={() => {
											setOpen(false);
											setDialog("invite");
										}}
									>
										<PlusIcon aria-hidden="true" />
										{m.invite_members()}
									</DropdownMenuItem>
								)}
								{project && (
									<DropdownMenuItem asChild className="min-h-8">
										<Link
											to="/settings"
											search={settingsSearch("project", selected)}
										>
											<SettingsIcon aria-hidden="true" />
											{m.project_settings()}
										</Link>
									</DropdownMenuItem>
								)}
							</DropdownMenuGroup>
							<DropdownMenuGroup>
								<div className="mt-2 flex items-center justify-between">
									<DropdownMenuLabel className="text-[11px] uppercase tracking-wide">
										{m.organization()}
									</DropdownMenuLabel>
									<DropdownMenuItem
										className="p-1"
										aria-label={m.create_organization()}
										onSelect={() => {
											setOpen(false);
											setDialog("organization");
										}}
									>
										<PlusIcon aria-hidden="true" className="size-4" />
									</DropdownMenuItem>
								</div>
								<DropdownMenuSeparator />
								<DropdownMenuSub>
									<DropdownMenuSubTrigger
										className="min-h-8"
										aria-label={m.choose_organization()}
									>
										<OrganizationAvatar organization={organization} />
										<span className="truncate font-medium">
											{organization?.name ?? m.organizations()}
										</span>
									</DropdownMenuSubTrigger>
									<DropdownMenuSubContent
										className="w-[min(20rem,calc(100vw-2rem))]"
										onFocus={(event) => {
											if (event.target === event.currentTarget)
												event.currentTarget.querySelector("input")?.focus();
										}}
									>
										<Command
											label={m.search_organizations()}
											onKeyDown={(event) => event.stopPropagation()}
										>
											<CommandInput
												aria-label={m.search_organizations()}
												placeholder={m.search_organizations()}
											/>
											<CommandList>
												<CommandEmpty>{m.no_matching_choices()}</CommandEmpty>
												<CommandGroup>
													{organizations.map((entry) => (
														<CommandItem
															key={entry.id}
															value={`${entry.name} ${entry.id}`}
															data-checked={entry.id === organization?.id}
															aria-label={entry.name}
															className="min-h-8 rounded-md [&>svg:last-child]:hidden"
															onSelect={() => void chooseOrganization(entry.id)}
														>
															<CheckIcon
																aria-hidden="true"
																className={
																	entry.id === organization?.id
																		? "size-4"
																		: "size-4 opacity-0"
																}
															/>
															<OrganizationAvatar organization={entry} />
															<span className="flex-1 truncate">
																{entry.name}
															</span>
															<Badge variant="outline">
																{roleLabel(entry.role)}
															</Badge>
														</CommandItem>
													))}
												</CommandGroup>
											</CommandList>
										</Command>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											className="min-h-9 rounded-md"
											onSelect={() => {
												setOpen(false);
												setDialog("organization");
											}}
										>
											<PlusIcon aria-hidden="true" />
											{m.new_organization()}
										</DropdownMenuItem>
									</DropdownMenuSubContent>
								</DropdownMenuSub>
								{organization && (
									<DropdownMenuItem asChild className="min-h-8">
										<Link
											to="/settings"
											search={settingsSearch("organization", selected)}
										>
											<SettingsIcon aria-hidden="true" />
											{m.organization_settings()}
										</Link>
									</DropdownMenuItem>
								)}
							</DropdownMenuGroup>
							<DropdownMenuGroup>
								<DropdownMenuLabel className="mt-2 text-[11px] uppercase tracking-wide">
									{m.account()}
								</DropdownMenuLabel>
								<DropdownMenuSeparator />
								<DropdownMenuItem asChild className="py-2">
									<Link
										to="/settings"
										search={settingsSearch("user", selected)}
										aria-label={m.user_settings()}
									>
										<UserAvatar user={user} />
										<div className="min-w-0 text-sm">
											<p className="truncate font-medium">{user.name}</p>
											<p className="truncate text-xs text-muted-foreground">
												{user.email}
											</p>
										</div>
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem
									className="min-h-8"
									disabled={pending}
									onSelect={(event) => {
										event.preventDefault();
										void logout();
									}}
								>
									<LogOutIcon aria-hidden="true" />
									{pending ? m.signing_out() : m.sign_out()}
								</DropdownMenuItem>
								{failure && (
									<p role="alert" className="p-2 text-sm text-destructive">
										{failure}
									</p>
								)}
							</DropdownMenuGroup>
						</CardContent>
					</Card>
				</DropdownMenuContent>
			</DropdownMenu>
			{(dialog === "organization" || dialog === "project") && (
				<WorkspaceCreationDialog
					kind={dialog}
					organization={organization}
					userId={user.id}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog === "invite" &&
				organization &&
				organization.role !== "member" && (
					<OrganizationInvitationPopup
						organization={organization}
						userId={user.id}
						onClose={() => setDialog(null)}
					/>
				)}
		</>
	);
}
