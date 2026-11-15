import { m } from "@recount/i18n/messages";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { DashboardPicker } from "../../analytics/dashboards/dashboard-picker";
import {
	getProjectHomeChoice,
	setProjectHome,
} from "../../analytics/dashboards.functions";
import { unwrapOperation } from "../../lib/operation-result";
import type { ProjectSummary } from "../../organizations/contracts";
import { FormFeedback } from "../form-feedback";
import { CommandItem } from "../ui/command";
import { Label } from "../ui/label";
import { nativeSelectControl } from "../ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useAppMutation } from "../use-app-mutation";
import { SettingsSection } from "./settings-section";

/** Whether the project opens on the fleet overview or on one of its dashboards. */
export function ProjectHomeSetting({ project }: { project: ProjectSummary }) {
	const { user } = getRouteApi("/_app").useRouteContext();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const reference = {
		organizationId: project.organizationId,
		projectId: project.id,
	};
	const queryKey = ["project-home", user.id, project.id];
	const home = useQuery({
		queryKey,
		queryFn: async ({ signal }) =>
			unwrapOperation(await getProjectHomeChoice({ data: reference, signal })),
	});
	const mutation = useAppMutation<
		string | null,
		{ dashboardId: string | null }
	>({
		userId: user.id,
		save: (dashboardId, signal) =>
			setProjectHome({ data: { ...reference, dashboardId }, signal }),
	});
	const disabled =
		project.role !== "admin" ||
		home.isPending ||
		mutation.disabled ||
		mutation.status === "uncertain" ||
		mutation.status === "refresh-failed";
	const current = home.data?.dashboardId ?? null;
	async function choose(dashboardId: string | null) {
		setOpen(false);
		if (disabled || dashboardId === current) return;
		const result = await mutation.submit(dashboardId);
		if (result && !result.error) {
			await queryClient.invalidateQueries({ queryKey });
			await result.refresh();
		}
	}
	return (
		<SettingsSection
			id="project-home"
			title={m.project_home()}
			description={m.project_home_description()}
		>
			<div className="flex max-w-sm flex-col gap-2">
				<Label htmlFor="project-home-choice">{m.project_home_opens()}</Label>
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							id="project-home-choice"
							role="combobox"
							aria-expanded={open}
							className={cn(
								nativeSelectControl,
								"relative text-left disabled:opacity-50",
							)}
							disabled={disabled}
						>
							<span className="block truncate">
								{home.data?.name ?? m.overview()}
							</span>
							<ChevronDownIcon
								aria-hidden="true"
								className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
							/>
						</button>
					</PopoverTrigger>
					<PopoverContent className="w-auto p-0" align="start">
						<DashboardPicker
							userId={user.id}
							reference={reference}
							selected={current}
							onPick={(dashboard) => void choose(dashboard.id)}
						>
							<CommandItem
								value={m.overview()}
								data-checked={current === null}
								onSelect={() => void choose(null)}
							>
								{m.overview()}
							</CommandItem>
						</DashboardPicker>
					</PopoverContent>
				</Popover>
			</div>
			<FormFeedback
				message={mutation.message}
				kind={mutation.kind}
				pending={mutation.pending}
				reserveLine={false}
			/>
		</SettingsSection>
	);
}
