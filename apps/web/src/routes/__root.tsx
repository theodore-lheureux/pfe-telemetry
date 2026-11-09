import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Link,
	Outlet,
	Scripts,
	useHydrated,
	useMatch,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { AuthenticationController } from "../auth/authentication";
import { PublicPreferences } from "../components/appearance-settings";
import { LocaleSafety } from "../components/locale-safety";
import { MutationFeedback } from "../components/mutation-feedback";
import { BrandLogo } from "../components/recount/brand-logo";
import { RouteNotFound } from "../components/route-feedback";
import { AppearanceContext } from "../lib/appearance";
import { clearValidation, localizeValidation } from "../lib/input-validation";
import { getInitialTheme, themeCookie } from "../lib/theme";
import css from "../styles.css?url";

export const Route = createRootRouteWithContext<{
	queryClient: QueryClient;
	authentication: AuthenticationController;
}>()({
	beforeLoad: () => ({ theme: getInitialTheme() }),
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: m.app_title() },
		],
		links: [
			{ rel: "stylesheet", href: css },
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/brand/recount-app-icon.svg",
			},
		],
	}),
	component: Outlet,
	shellComponent: RootDocument,
	notFoundComponent: RouteNotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
	const { theme: initialTheme } = Route.useRouteContext();
	const [theme, setTheme] = useState(initialTheme ?? "tide");
	const hydrated = useHydrated();
	const appMatch = useMatch({
		from: "/_app",
		shouldThrow: false,
	});
	const hasAppLayout = appMatch?.status === "success";
	return (
		<html lang={getLocale()} data-theme={theme} data-variant="core">
			<head>
				<HeadContent />
			</head>
			<body
				className="flex min-h-svh flex-col"
				onInvalidCapture={(event) => localizeValidation(event.target)}
				onInputCapture={(event) => clearValidation(event.target)}
				onChangeCapture={(event) => clearValidation(event.target)}
			>
				<LocaleSafety>
					<AppearanceContext
						value={{
							mode: theme === "tide-dark" ? "dark" : "light",
							disabled: !hydrated,
							onModeChange: (mode) => {
								const next = mode === "dark" ? "tide-dark" : "tide";
								// biome-ignore lint/suspicious/noDocumentCookie: Cookie Store is not available in every supported browser.
								document.cookie = `${themeCookie}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
								setTheme(next);
							},
						}}
					>
						<a
							href={hasAppLayout ? "#main-content" : "#page-content"}
							className="sr-only focus:not-sr-only focus:block focus:p-3 focus:outline-2 focus:outline-ring"
						>
							{m.skip_to_content()}
						</a>
						{!appMatch && (
							<header className="border-b bg-card" data-public-header>
								<div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
									<Link
										to="/"
										aria-label={m.brand_home()}
										className="inline-flex rounded-md p-1 focus-visible:outline-2 focus-visible:outline-ring"
									>
										<BrandLogo />
									</Link>
								</div>
							</header>
						)}
						<div id="page-content" tabIndex={-1} className="flex-1">
							<MutationFeedback>{children}</MutationFeedback>
						</div>
						{!appMatch && (
							<footer className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-center gap-3 px-4 py-4 text-muted-foreground sm:px-6">
								<PublicPreferences />
							</footer>
						)}
					</AppearanceContext>
				</LocaleSafety>
				<Scripts />
			</body>
		</html>
	);
}
