import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useAppearance } from "../lib/appearance";
import { LanguageSwitcher } from "./language-switcher";
import { SettingsPageHeading } from "./settings/settings-page-heading";
import { SettingsSection } from "./settings/settings-section";
import { ThemeSelector } from "./theme-selector";

const SITE_URL = "https://recount.cloud";

// Footer for signed-out pages, echoing the recount.cloud footer: copyright and site links
// on one side, language and theme on the other.
export function PublicFooter() {
	const appearance = useAppearance();
	const site = (path: string) =>
		`${SITE_URL}${getLocale() === "fr" ? "/fr" : ""}${path}`;
	const links = [
		{ href: site("/docs/"), label: m.email_footer_docs() },
		{ href: site("/privacy/"), label: m.email_footer_privacy() },
		{ href: site("/terms/"), label: m.email_footer_terms() },
	];
	return (
		<footer className="border-t">
			<div className="mx-auto flex w-full max-w-7xl flex-col-reverse items-center gap-3 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-6">
				<div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
					<span>© {new Date().getFullYear()} Recount</span>
					<nav aria-label={m.public_footer_links()}>
						<ul className="flex items-center gap-4">
							{links.map((link) => (
								<li key={link.href}>
									<a
										href={link.href}
										className="transition-colors hover:text-foreground"
									>
										{link.label}
									</a>
								</li>
							))}
						</ul>
					</nav>
				</div>
				<div className="flex items-center gap-1">
					<LanguageSwitcher compact />
					<ThemeSelector {...appearance} compact />
				</div>
			</div>
		</footer>
	);
}

export function AppearancePreferences() {
	const appearance = useAppearance();
	return (
		<div className="flex max-w-xl flex-col gap-5">
			<SettingsPageHeading description={m.preferences_description()} />
			<SettingsSection id="theme" title={m.theme()}>
				<div className="self-start">
					<ThemeSelector {...appearance} />
				</div>
			</SettingsSection>
			<section className="flex flex-wrap items-center justify-between gap-4">
				<h2>{m.language()}</h2>
				<LanguageSwitcher />
			</section>
		</div>
	);
}
