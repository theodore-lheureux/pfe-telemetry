import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { getRouteApi } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import type {
	ProjectCustomizationChange,
	ProjectSummary,
} from "../../organizations/contracts";
import { updateProjectCustomization } from "../../organizations/organization.functions";
import { FormFeedback } from "../form-feedback";
import { TagList } from "../tag-list";
import { Button } from "../ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../ui/command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	NativeSelect,
	NativeSelectOption,
	nativeSelectControl,
} from "../ui/native-select";
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
	const [zoneOpen, setZoneOpen] = useState(false);
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
						{m.tags()}
					</h3>
					<TagList
						tags={project.tags}
						editable={project.role === "admin"}
						disabled={disabled}
						onAdd={(tag) => change({ action: "add-tag", tag })}
						onRemove={(tag) => void change({ action: "remove-tag", tag })}
					/>
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
				<div className="grid max-w-2xl items-start gap-6 sm:grid-cols-[minmax(0,1fr)_12rem]">
					<div className="flex min-w-0 flex-col gap-2">
						<Label htmlFor="project-time-zone">{m.project_time_zone()}</Label>
						<Popover open={zoneOpen} onOpenChange={setZoneOpen}>
							<PopoverTrigger asChild>
								<button
									type="button"
									id="project-time-zone"
									role="combobox"
									aria-expanded={zoneOpen}
									className={cn(
										nativeSelectControl,
										"relative text-left disabled:opacity-50",
									)}
									disabled={disabled}
								>
									<span className="block truncate">
										{timeZoneLabel(project.timeZone)}
									</span>
									<ChevronDownIcon
										aria-hidden="true"
										className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
									/>
								</button>
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
										<CommandGroup>
											{[...new Set([...timeZones, project.timeZone])].map(
												(timeZone) => (
													<CommandItem
														key={timeZone}
														data-checked={timeZone === project.timeZone}
														value={timeZone}
														disabled={disabled}
														onSelect={() => {
															setZoneOpen(false);
															if (timeZone !== project.timeZone)
																void change({ action: "time-zone", timeZone });
														}}
													>
														{timeZone}
													</CommandItem>
												),
											)}
										</CommandGroup>
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
							{[0, 1].map((day) => (
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
