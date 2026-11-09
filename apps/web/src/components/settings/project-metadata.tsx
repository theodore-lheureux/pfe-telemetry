import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { getRouteApi } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type {
	ProjectCustomizationChange,
	ProjectSummary,
} from "../../organizations/contracts";
import { updateProjectCustomization } from "../../organizations/organization.functions";
import { FormFeedback } from "../form-feedback";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "../ui/command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useAppMutation } from "../use-app-mutation";
import { SettingsSection } from "./settings-section";

const timeZones = ["UTC", ...Intl.supportedValuesOf("timeZone")];

export function timeZoneLabel(timeZone: string, date = new Date()) {
	const offset = new Intl.DateTimeFormat("en", {
		timeZone,
		timeZoneName: "shortOffset",
	})
		.formatToParts(date)
		.find((part) => part.type === "timeZoneName")
		?.value.replace("GMT", "UTC");
	return `${timeZone} (${offset})`;
}

export function ProjectMetadata({ project }: { project: ProjectSummary }) {
	const { user } = getRouteApi("/_app").useRouteContext();
	const [tagOpen, setTagOpen] = useState(false);
	const [zoneOpen, setZoneOpen] = useState(false);
	const [tag, setTag] = useState("");
	const [group, setGroup] = useState(project.projectGroup);
	const mutation = useAppMutation<ProjectCustomizationChange, ProjectSummary>({
		userId: user.id,
		save: (input, signal) =>
			updateProjectCustomization({
				data: {
					organizationId: project.organizationId,
					projectId: project.id,
					...input,
				},
				signal,
			}),
	});
	const disabled =
		project.role !== "admin" ||
		mutation.disabled ||
		mutation.status === "uncertain" ||
		mutation.status === "refresh-failed";
	async function change(input: ProjectCustomizationChange) {
		if (disabled) return false;
		const result = await mutation.submit(input);
		return result && !result.error ? result.refresh() : false;
	}
	const weekdays = new Intl.DateTimeFormat(getLocale(), {
		weekday: "long",
		timeZone: "UTC",
	});
	return (
		<>
			<div className="-mt-4 flex flex-col gap-5">
				<div className="flex flex-col gap-3">
					<h3 id="project-tags" className="scroll-mt-6 text-sm font-semibold">
						{m.project_tags()}
					</h3>
					<div className="flex flex-wrap items-center gap-2">
						{project.tags.map((tag) => (
							<Badge key={tag} variant="outline" className="gap-1 py-1">
								{tag}
								{project.role === "admin" && (
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										className="size-4"
										disabled={disabled}
										aria-label={m.project_remove_tag({ tag })}
										onClick={() => void change({ action: "remove-tag", tag })}
									>
										<XIcon aria-hidden="true" className="size-3" />
									</Button>
								)}
							</Badge>
						))}
						<Popover
							open={tagOpen}
							onOpenChange={(open) => {
								if (!mutation.pending) setTagOpen(open);
							}}
						>
							<PopoverTrigger asChild>
								<Button
									type="button"
									size="sm"
									variant="outline"
									className="border-dashed"
									disabled={disabled || project.tags.length >= 20}
								>
									<PlusIcon aria-hidden="true" />
									{m.project_add_tag()}
								</Button>
							</PopoverTrigger>
							<PopoverContent align="start">
								<form
									method="post"
									className="flex flex-col gap-3"
									onSubmit={async (event) => {
										event.preventDefault();
										if (await change({ action: "add-tag", tag })) {
											setTag("");
											setTagOpen(false);
										}
									}}
								>
									<Label htmlFor="project-tag-input">{m.project_tag()}</Label>
									<Input
										id="project-tag-input"
										value={tag}
										onChange={(event) => setTag(event.target.value)}
										required
										maxLength={40}
										disabled={disabled}
										autoComplete="off"
									/>
									<Button type="submit" disabled={disabled || !tag.trim()}>
										{m.project_save_tag()}
									</Button>
								</form>
							</PopoverContent>
						</Popover>
					</div>
				</div>
				<form
					method="post"
					className="flex max-w-lg flex-wrap items-end gap-2"
					onSubmit={async (event) => {
						event.preventDefault();
						if (await change({ action: "group", projectGroup: group }))
							setGroup(group.trim());
					}}
				>
					<div className="flex min-w-48 flex-1 flex-col gap-2">
						<Label htmlFor="project-group">{m.project_group()}</Label>
						<Input
							id="project-group"
							value={group}
							onChange={(event) => setGroup(event.target.value)}
							placeholder={m.project_group_placeholder()}
							maxLength={80}
							disabled={disabled}
							autoComplete="off"
						/>
					</div>
					<Button
						type="submit"
						variant="outline"
						disabled={disabled || group.trim() === project.projectGroup}
						aria-label={m.project_save_group()}
					>
						{m.save_setting()}
					</Button>
				</form>
			</div>
			<SettingsSection
				id="project-date-time"
				title={m.project_date_time()}
				description={m.project_date_time_description()}
			>
				<div className="grid max-w-4xl items-start gap-6 sm:grid-cols-[minmax(0,1fr)_12rem]">
					<div className="flex min-w-0 flex-col gap-2">
						<Label htmlFor="project-time-zone">{m.project_time_zone()}</Label>
						<Popover open={zoneOpen} onOpenChange={setZoneOpen}>
							<PopoverTrigger asChild>
								<Button
									id="project-time-zone"
									role="combobox"
									aria-expanded={zoneOpen}
									variant="outline"
									className="w-full justify-between"
									disabled={disabled}
								>
									<span className="truncate">
										{timeZoneLabel(project.timeZone)}
									</span>
									<ChevronsUpDownIcon
										aria-hidden="true"
										className="size-4 shrink-0"
									/>
								</Button>
							</PopoverTrigger>
							<PopoverContent
								className="w-(--radix-popover-trigger-width) min-w-64 p-0"
								align="start"
							>
								<Command>
									<CommandInput
										aria-label={m.project_search_time_zones()}
										placeholder={m.project_search_time_zones()}
									/>
									<CommandList>
										<CommandEmpty>{m.no_matching_choices()}</CommandEmpty>
										{[...new Set([...timeZones, project.timeZone])].map(
											(timeZone) => (
												<CommandItem
													key={timeZone}
													value={timeZone}
													disabled={disabled}
													onSelect={() => {
														setZoneOpen(false);
														if (timeZone !== project.timeZone)
															void change({ action: "time-zone", timeZone });
													}}
												>
													{timeZone}
													<CheckIcon
														aria-hidden="true"
														className={
															timeZone === project.timeZone
																? "ml-auto size-4"
																: "ml-auto size-4 invisible"
														}
													/>
												</CommandItem>
											),
										)}
									</CommandList>
								</Command>
							</PopoverContent>
						</Popover>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="project-week-start">{m.project_week_start()}</Label>
						<NativeSelect
							id="project-week-start"
							value={String(project.weekStartsOn)}
							disabled={disabled}
							onChange={(event) =>
								void change({
									action: "week-start",
									weekStartsOn: Number(event.target.value),
								})
							}
						>
							{[0, 1, 2, 3, 4, 5, 6].map((day) => (
								<NativeSelectOption key={day} value={day}>
									{weekdays.format(new Date(Date.UTC(2026, 10, 8 + day)))}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
				</div>
				<p className="text-xs text-muted-foreground">
					{m.project_calendar_note()}
				</p>
			</SettingsSection>
			<FormFeedback
				message={mutation.message}
				kind={mutation.kind}
				pending={mutation.pending}
				reserveLine={false}
			/>
		</>
	);
}
