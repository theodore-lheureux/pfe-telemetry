import { m } from "@recount/i18n/messages";
import { useAppearance } from "../lib/appearance";
import { LanguageSwitcher } from "./language-switcher";
import { TideModeToggle } from "./recount/tide-mode-toggle";

export function PublicPreferences() {
	const appearance = useAppearance();
	return (
		<>
			<LanguageSwitcher />
			<TideModeToggle {...appearance} />
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
			<section
				id="appearance"
				className="flex items-center justify-between gap-4"
			>
				<h2>{m.appearance()}</h2>
				<TideModeToggle {...appearance} />
			</section>
			<section className="flex flex-wrap items-center justify-between gap-4">
				<h2>{m.language()}</h2>
				<LanguageSwitcher />
			</section>
		</div>
	);
}
