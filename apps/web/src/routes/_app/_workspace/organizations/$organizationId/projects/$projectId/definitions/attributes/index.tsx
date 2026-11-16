import { createFileRoute } from "@tanstack/react-router";
import { AttributeList } from "@/definitions/attribute-list";
import { listAttributeDefinitions } from "@/definitions/definitions.functions";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/definitions/attributes/",
)({
	loader: async ({ params, location }) =>
		routeData(
			await listAttributeDefinitions({ data: projectParams(params) }),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	component: Attributes,
});

function Attributes() {
	const { user } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	return (
		<AttributeList
			key={`${user.id}/${reference.projectId}`}
			reference={reference}
			attributes={Route.useLoaderData()}
		/>
	);
}
