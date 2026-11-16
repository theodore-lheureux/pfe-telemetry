import { createFileRoute, notFound } from "@tanstack/react-router";
import { AttributeDetailPage } from "@/definitions/attribute-detail";
import { ATTRIBUTE_SCOPES, type AttributeScope } from "@/definitions/contracts";
import { getAttributeDefinition } from "@/definitions/definitions.functions";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/definitions/attributes/$scope/$key",
)({
	loader: async ({ params, location }) => {
		if (!(ATTRIBUTE_SCOPES as readonly string[]).includes(params.scope))
			throw notFound();
		return routeData(
			await getAttributeDefinition({
				data: {
					...projectParams(params),
					scope: params.scope as AttributeScope,
					key: params.key,
				},
			}),
			location.href,
		);
	},
	staleTime: 0,
	gcTime: 0,
	component: Attribute,
});

function Attribute() {
	const { user, project } = Route.useRouteContext();
	const params = Route.useParams();
	const reference = projectParams(params);
	return (
		<AttributeDetailPage
			key={`${user.id}/${reference.projectId}/${params.scope}/${params.key}`}
			userId={user.id}
			reference={reference}
			canWrite={project.role !== "viewer"}
			detail={Route.useLoaderData()}
		/>
	);
}
