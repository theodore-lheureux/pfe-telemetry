import { m } from "@recount/i18n/messages";
import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import {
	ChevronDownIcon,
	LogOutIcon,
	PlusIcon,
	SettingsIcon,
	UsersIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "../organizations/contracts";
import {
	type ApplicationUser,
	OrganizationAvatar,
	ProjectAvatar,
	UserAvatar,
} from "./identity-avatar";
import { useLocaleChangeBlocker } from "./locale-safety";
import { useMutationFeedback } from "./mutation-feedback";
import { type SettingsSection, settingsSearch } from "./settings-links";
import { signOutOfApplication } from "./sign-out";
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
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState("");
	const busy = useRef(false);
	useLocaleChangeBlocker(pending);
	async function logout() {
		if (busy.current) return;
		busy.current = true;
		setPending(true);
		setFailure("");
		try {
			setFailure(await signOutOfApplication(router, setFeedback));
		} catch {
			setFailure(m.signout_failed_please_try_again());
		} finally {
			busy.current = false;
			setPending(false);
		}
	}
	function chooseOrganization(organizationId?: string) {
		setOpen(false);
		onNavigate?.();
		if (!organizationId) return router.navigate({ to: "/" });
		if (settingsSection)
			return router.navigate({
				to: "/settings",
				search: settingsSearch(
					settingsSection === "user" || settingsSection === "appearance"
						? settingsSection
						: "organization",
					{ organizationId },
				),
			});
		return router.navigate({
			to: "/organizations/$organizationId",
			params: { organizationId },
		});
	}
	function chooseProject(projectId?: string) {
		if (!organization) return;
		setOpen(false);
		onNavigate?.();
		if (!projectId)
			return router.navigate({
				to: "/organizations/$organizationId",
				params: { organizationId: organization.id },
			});
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
									<DropdownMenuItem asChild className="p-1">
										<Link
											to="/organizations/$organizationId/projects/new"
											params={{ organizationId: organization.id }}
											aria-label={m.create_project()}
										>
											<PlusIcon aria-hidden="true" className="size-4" />
										</Link>
									</DropdownMenuItem>
								)}
							</div>
							<DropdownMenuSeparator />
							<DropdownMenuSub>
								<DropdownMenuSubTrigger
									className="min-h-8"
									disabled={!organization}
									aria-label={m.choose_project()}
								>
									<ProjectAvatar
										name={project?.name ?? m.all_visible_projects()}
									/>
									<span className="truncate font-medium">
										{project?.name ?? m.all_visible_projects()}
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
											<CommandItem
												value={m.all_visible_projects()}
												onSelect={() => void chooseProject()}
											>
												{m.all_visible_projects()}
											</CommandItem>
											{[...projectGroups].map(([group, entries]) => (
												<CommandGroup
													key={group}
													heading={group || m.project_ungrouped()}
												>
													{entries.map((entry) => (
														<CommandItem
															key={entry.id}
															value={`${entry.name} ${entry.slug} ${entry.id} ${entry.projectGroup} ${entry.tags.join(" ")}`}
															data-checked={entry.id === project?.id}
															onSelect={() => void chooseProject(entry.id)}
														>
															<ProjectAvatar name={entry.name} />
															<span className="truncate">{entry.name}</span>
														</CommandItem>
													))}
												</CommandGroup>
											))}
										</CommandList>
									</Command>
								</DropdownMenuSubContent>
							</DropdownMenuSub>
							{project?.role === "admin" && (
								<DropdownMenuItem asChild className="min-h-8">
									<Link
										to="/settings"
										search={settingsSearch("project-members", selected)}
									>
										<UsersIcon aria-hidden="true" />
										{m.project_members()}
									</Link>
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
								<DropdownMenuItem asChild className="p-1">
									<Link
										to="/organizations/new"
										aria-label={m.new_organization()}
									>
										<PlusIcon aria-hidden="true" className="size-4" />
									</Link>
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
										{organization?.name ?? m.all_organizations()}
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
											<CommandItem
												value={m.all_organizations()}
												onSelect={() => void chooseOrganization()}
											>
												{m.all_organizations()}
											</CommandItem>
											{organizations.map((entry) => (
												<CommandItem
													key={entry.id}
													value={`${entry.name} ${entry.id}`}
													data-checked={entry.id === organization?.id}
													onSelect={() => void chooseOrganization(entry.id)}
												>
													<OrganizationAvatar organization={entry} />
													<span className="truncate">{entry.name}</span>
												</CommandItem>
											))}
										</CommandList>
									</Command>
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
									<UserAvatar
										key={`${user.id}/${user.image ?? ""}`}
										user={user}
									/>
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
	);
}
