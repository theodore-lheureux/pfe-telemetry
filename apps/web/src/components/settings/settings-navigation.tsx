import { m } from "@recount/i18n/messages";
import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "../../organizations/contracts";
import { type SettingsSearch, settingsSearch } from "../settings-links";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../ui/collapsible";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../ui/command";
import { SidebarMenuButton } from "../ui/sidebar";
import { getSettingsGroups, searchSettings } from "./settings-catalog";

export function SettingsNavigation({
	selection,
	organization,
	project,
}: {
	selection: SettingsSearch;
	organization?: OrganizationSummary;
	project?: ProjectSummary;
}) {
	const [query, setQuery] = useState("");
	const hydrated = useHydrated();
	const router = useRouter();
	const groups = getSettingsGroups({ organization, project });
	const results = searchSettings(groups, query);
	const searching = !!query.trim();
	return (
		<nav
			aria-label={m.settings_navigation()}
			className="shrink-0 lg:sticky lg:top-6 lg:w-60 lg:self-start"
		>
			<Card className="gap-0 border bg-transparent py-0 shadow-none ring-0 lg:h-[calc(100dvh-3.5rem)]">
				<Collapsible className="flex min-h-0 flex-1 flex-col">
					<CollapsibleTrigger asChild>
						<Button
							disabled={!hydrated}
							variant="outline"
							className="w-full justify-between lg:hidden"
						>
							<span className="truncate">
								{m.settings()} ·{" "}
								{
									groups
										.flatMap((group) => group.pages)
										.find((item) => item.section === selection.section)?.label
								}
							</span>
							<ChevronDownIcon
								aria-hidden="true"
								className="size-4 shrink-0 transition-transform in-data-[state=open]:rotate-180"
							/>
						</Button>
					</CollapsibleTrigger>
					<CollapsibleContent
						forceMount
						className="hidden min-h-0 flex-1 flex-col data-[state=open]:flex lg:flex"
					>
						<Command
							label={m.search_settings()}
							shouldFilter={false}
							className="min-h-0 flex-1 rounded-none! bg-transparent p-0"
						>
							<div className="shrink-0 border-b pb-1">
								<h2 className="sr-only">{m.settings()}</h2>
								<CommandInput
									disabled={!hydrated}
									value={query}
									onValueChange={setQuery}
									aria-label={m.search_settings()}
									aria-expanded={searching}
									placeholder={m.search_settings()}
									onKeyDown={(event) => {
										if (event.key === "Escape" && searching) {
											event.stopPropagation();
											setQuery("");
										}
									}}
								/>
							</div>
							<CommandList
								className={searching ? "min-h-0 max-h-none flex-1" : "hidden"}
							>
								<CommandEmpty>{m.no_matching_settings()}</CommandEmpty>
								{searching &&
									results.map((page) => (
										<CommandGroup
											key={page.section}
											heading={page.group}
											className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
										>
											{page.settings.map((setting) => (
												<CommandItem
													key={setting.id}
													value={`${page.section}/${setting.id}`}
													onSelect={() => {
														setQuery("");
														void router.navigate({
															to: "/settings",
															search: settingsSearch(page.section, selection),
															hash: setting.id,
															hashScrollIntoView: { block: "center" },
														});
													}}
												>
													{setting.label}
												</CommandItem>
											))}
										</CommandGroup>
									))}
							</CommandList>
							{!searching && (
								<div className="min-h-0 flex-1 overflow-y-auto p-1">
									{groups.map((group) => (
										<Collapsible
											key={`${group.label}/${Boolean(query)}`}
											defaultOpen
											className="mb-1 last:mb-0"
										>
											<CollapsibleTrigger asChild>
												<SidebarMenuButton
													disabled={!hydrated}
													size="sm"
													className="gap-2 py-1 text-[13px] font-medium"
												>
													<ChevronDownIcon
														aria-hidden="true"
														className="size-3.5 transition-transform in-data-[state=open]:rotate-180"
													/>
													{group.label}
												</SidebarMenuButton>
											</CollapsibleTrigger>
											<CollapsibleContent className="flex flex-col gap-px">
												{group.pages.map((item) => (
													<SidebarMenuButton
														asChild
														size="sm"
														key={item.section}
														className="py-1 pl-7 text-[13px]"
														isActive={selection.section === item.section}
													>
														<Link
															to="/settings"
															search={settingsSearch(item.section, selection)}
															activeOptions={{ exact: true }}
															activeProps={{
																className:
																	"active bg-accent text-accent-foreground",
															}}
														>
															{item.label}
														</Link>
													</SidebarMenuButton>
												))}
											</CollapsibleContent>
										</Collapsible>
									))}
								</div>
							)}
						</Command>
					</CollapsibleContent>
				</Collapsible>
			</Card>
		</nav>
	);
}
