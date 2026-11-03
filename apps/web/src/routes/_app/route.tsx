import { m } from "@pfe/i18n/messages";
import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { getCurrentUser } from "@/auth/session.functions";
import { navClass } from "@/components/workspace";

export const Route = createFileRoute("/_app")({
	beforeLoad: async ({ location }) => {
		const user = await getCurrentUser();
		if (!user)
			throw redirect({
				to: "/login",
				search: { redirect: location.href },
			});
		return { user };
	},
	headers: () => ({ "Cache-Control": "private, no-store" }),
	staleTime: 0,
	gcTime: 0,
	component: App,
});

function App() {
	const { user } = Route.useRouteContext();
	return (
		<div className="bg-background">
			<div className="border-b bg-card">
				<div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-2 sm:px-6">
					<nav
						aria-label={m.account()}
						className="flex flex-wrap items-center gap-2"
					>
						<Link to="/" className={navClass} activeOptions={{ exact: true }}>
							{m.organizations()}
						</Link>
						<Link to="/account" className={navClass}>
							{m.account()}
							<span className="sr-only">: {user.email}</span>
						</Link>
					</nav>
				</div>
			</div>
			<main
				id="main-content"
				tabIndex={-1}
				className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6"
			>
				<Outlet />
			</main>
		</div>
	);
}
