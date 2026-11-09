import { m } from "@recount/i18n/messages";
import {
	createFileRoute,
	notFound,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { CollectorCredentials } from "@/components/collector-credentials";
import { PageHeading } from "@/components/workspace";
import { listCollectorCredentials } from "@/credentials/credential.functions";
import { projectParams } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/settings/credentials",
)({
	loader: async ({ context, params, location }) => {
		if (context.project.role !== "admin") return null;
		const reference = projectParams(params);
		const result = await listCollectorCredentials({ data: reference }).catch(
			() => null,
		);
		if (result?.error?.code === "UNAUTHENTICATED")
			throw redirect({
				to: "/login",
				search: { redirect: location.href },
			});
		if (result?.error?.code === "NOT_FOUND") throw notFound();
		return { result, asOf: Date.now() };
	},
	staleTime: 0,
	gcTime: 0,
	headers: () => ({ "Cache-Control": "private, no-store" }),
	head: () => ({
		meta: [{ title: `${m.collector_credentials()} · ${m.app_title()}` }],
	}),
	component: Credentials,
});

function Credentials() {
	const { project, user } = Route.useRouteContext();
	const loaded = Route.useLoaderData();
	const result = loaded?.result;
	const router = useRouter();
	return (
		<>
			<PageHeading title={m.collector_credentials()}>
				{m.enroll_collector_sources_for_this_private_project()}
			</PageHeading>
			{project.role === "admin" && result?.error?.code !== "FORBIDDEN" ? (
				<CollectorCredentials
					key={`${user.id}:${project.organizationId}:${project.id}`}
					project={project}
					credentials={result?.data ?? null}
					asOf={loaded?.asOf ?? 0}
					refreshList={() =>
						router.invalidate({
							filter: (match) => match.routeId === Route.id,
							sync: true,
						})
					}
					refreshAccess={() => router.invalidate({ sync: true })}
				/>
			) : (
				<p className="text-sm text-muted-foreground">
					{m.you_have_read_access_only_effective_project_administrators()}
				</p>
			)}
		</>
	);
}
