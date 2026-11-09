import { m } from "@recount/i18n/messages";
import { useAppearance } from "../lib/appearance";
import { LanguageSwitcher } from "./language-switcher";
import { SettingsSection } from "./settings/settings-section";
import { ThemeSelector } from "./theme-selector";

export function PublicPreferences() {
	const appearance = useAppearance();
	return (
		<>
			<LanguageSwitcher />
			<ThemeSelector {...appearance} />
		</>
	);
}

export function AppearancePreferences() {
	const appearance = useAppearance();
	return (
		<div className="flex max-w-xl flex-col gap-5">
			<h1>{m.appearance()}</h1>
			<p className="text-sm text-muted-foreground">
				{m.preferences_description()}
			</p>
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
