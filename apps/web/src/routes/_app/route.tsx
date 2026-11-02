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
		<div className="min-h-svh bg-background">
			<a
				href="#main-content"
				className="sr-only focus:not-sr-only focus:block focus:p-3"
			>
				{m.skip_to_content()}
			</a>
			<header className="border-b">
				<div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
					<Link to="/" className="font-semibold tracking-tight">
						{m.app_title()}
					</Link>
					<nav aria-label={m.account()} className="flex items-center gap-2">
						<Link to="/" className={navClass} activeOptions={{ exact: true }}>
							{m.organizations()}
						</Link>
						<Link to="/account" className={navClass}>
							{m.account()}
							<span className="sr-only">: {user.email}</span>
						</Link>
					</nav>
				</div>
			</header>
			<main
				id="main-content"
				className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-8"
			>
				<Outlet />
			</main>
		</div>
	);
}
