import { m } from "@pfe/i18n/messages";
import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "../organizations/contracts";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Label } from "./ui/label";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";

export const navClass =
	"inline-flex min-h-8 items-center rounded-md px-3 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&.active]:bg-accent [&.active]:text-accent-foreground";

export function PageHeading({
	title,
	children,
}: {
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			{children && (
				<p className="max-w-2xl text-sm text-muted-foreground">{children}</p>
			)}
		</div>
	);
}

export function EmptyState({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<Empty className="items-start border border-dashed bg-card p-5 text-left">
			<EmptyHeader className="items-start text-left">
				<EmptyTitle>
					<h2>{title}</h2>
				</EmptyTitle>
			</EmptyHeader>
			<EmptyContent className="items-start text-left">{children}</EmptyContent>
		</Empty>
	);
}

export function OrganizationSwitcher({
	organizations,
	organizationId = "",
}: {
	organizations: OrganizationSummary[];
	organizationId?: string;
}) {
	const router = useRouter();
	const hydrated = useHydrated();
	return (
		<form
			className="flex flex-wrap items-end gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				const organizationId = String(
					new FormData(event.currentTarget).get("organizationId") ?? "",
				);
				void (organizationId
					? router.navigate({
							to: "/organizations/$organizationId",
							params: { organizationId },
						})
					: router.navigate({ to: "/" }));
			}}
		>
			<div className="w-full sm:w-72">
				<Label
					className="mb-1 block text-xs font-medium text-muted-foreground"
					htmlFor="organization-switcher"
				>
					{m.organization()}
				</Label>
				<NativeSelect
					id="organization-switcher"
					name="organizationId"
					className="w-full"
					defaultValue={organizationId}
					disabled={!hydrated}
				>
					<NativeSelectOption value="">
						{m.all_organizations()}
					</NativeSelectOption>
					{organizations.map((organization) => (
						<NativeSelectOption key={organization.id} value={organization.id}>
							{organization.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			<Button type="submit" variant="outline" disabled={!hydrated}>
				{m.switch_organization()}
			</Button>
			<Link to="/organizations/new" className={navClass}>
				{m.new_organization()}
			</Link>
		</form>
	);
}

export function ProjectSwitcher({
	projects,
	organizationId,
	projectId = "",
}: {
	projects: ProjectSummary[];
	organizationId: string;
	projectId?: string;
}) {
	const router = useRouter();
	const hydrated = useHydrated();
	return (
		<form
			className="flex flex-wrap items-end gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				const projectId = String(
					new FormData(event.currentTarget).get("projectId") ?? "",
				);
				void (projectId
					? router.navigate({
							to: "/organizations/$organizationId/projects/$projectId/executions",
							params: { organizationId, projectId },
						})
					: router.navigate({
							to: "/organizations/$organizationId",
							params: { organizationId },
						}));
			}}
		>
			<div className="w-full sm:w-72">
				<Label
					htmlFor="project-switcher"
					className="mb-1 block text-xs font-medium text-muted-foreground"
				>
					{m.project()}
				</Label>
				<NativeSelect
					id="project-switcher"
					name="projectId"
					className="w-full"
					defaultValue={projectId}
					disabled={!hydrated}
				>
					<NativeSelectOption value="">
						{m.all_visible_projects()}
					</NativeSelectOption>
					{projects.map((project) => (
						<NativeSelectOption key={project.id} value={project.id}>
							{project.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			<Button type="submit" variant="outline" disabled={!hydrated}>
				{m.switch_project()}
			</Button>
		</form>
	);
}
