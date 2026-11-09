import { m } from "@recount/i18n/messages";
import { CollectorCredentials } from "@/components/collector-credentials";
import { PageHeading } from "@/components/workspace";
import type { listCollectorCredentials } from "@/credentials/credential.functions";
import type { ProjectSummary } from "@/organizations/contracts";

export function CredentialsSettings({
	project,
	userId,
	loaded,
	refreshList,
	refreshAccess,
}: {
	project: ProjectSummary;
	userId: string;
	loaded: {
		result: Awaited<ReturnType<typeof listCollectorCredentials>> | null;
		asOf: number;
	} | null;
	refreshList: () => Promise<void>;
	refreshAccess: () => Promise<void>;
}) {
	const result = loaded?.result;
	return (
		<>
			<PageHeading title={m.collector_credentials()}>
				{m.enroll_collector_sources_for_this_private_project()}
			</PageHeading>
			{project.role === "admin" && result?.error?.code !== "FORBIDDEN" ? (
				<CollectorCredentials
					key={`${userId}:${project.organizationId}:${project.id}`}
					project={project}
					credentials={result?.data ?? null}
					asOf={loaded?.asOf ?? 0}
					refreshList={refreshList}
					refreshAccess={refreshAccess}
				/>
			) : (
				<p className="text-sm text-muted-foreground">
					{m.you_have_read_access_only_effective_project_administrators()}
				</p>
			)}
		</>
	);
}
