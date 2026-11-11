import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { LOCALE_KEY, langFromPath } from "./src/i18n/locale.mjs";
import { localeInitializationScript } from "./src/i18n/preference-script.mjs";
import { analyticsScript } from "./src/lib/analytics.mjs";

const localeScript = `${localeInitializationScript}
(() => {
	document.addEventListener("change", (event) => {
		const select = event.target;
		if (select instanceof HTMLSelectElement && select.closest("starlight-lang-select")) {
			try { localStorage.setItem(${JSON.stringify(LOCALE_KEY)}, (${langFromPath.toString()})(select.value)); } catch {}
		}
	}, true);
})();`;

export default defineConfig({
	site: "https://recount.cloud",
	integrations: [
		starlight({
			title: { en: "Recount Docs", fr: "Documentation Recount" },
			defaultLocale: "root",
			locales: {
				root: { label: "English", lang: "en" },
				fr: { label: "Français", lang: "fr" },
			},
			logo: {
				light: "./src/assets/recount-lockup-on-light.svg",
				dark: "./src/assets/recount-lockup-on-dark.svg",
				replacesTitle: true,
			},
			favicon: "/brand/recount-app-icon.svg",
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/theodore-lheureux/pfe-telemetry",
				},
			],
			customCss: ["./src/styles/docs.css"],
			components: { SocialIcons: "./src/components/docs/SocialIcons.astro" },
			// Code blocks use GitHub's syntax colors on Tide surfaces, with the kit's 4px corners.
			expressiveCode: {
				themes: ["github-dark-default", "github-light-default"],
				styleOverrides: {
					borderRadius: "4px",
					borderColor: "var(--sl-color-hairline)",
					codeBackground: "var(--sl-color-gray-6)",
					frames: {
						frameBoxShadowCssValue: "none",
						editorTabBarBackground: "var(--sl-color-gray-6)",
						editorActiveTabBackground: "var(--sl-color-gray-6)",
						terminalTitlebarBackground: "var(--sl-color-gray-6)",
						terminalBackground: "var(--sl-color-gray-6)",
					},
				},
			},
			// The landing page provides the site-wide 404.
			disable404Route: true,
			head: [
				{ tag: "script", content: localeScript },
				{
					tag: "link",
					attrs: { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
				},
				{
					tag: "link",
					attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
				},
				{ tag: "link", attrs: { rel: "manifest", href: "/site.webmanifest" } },
				{
					tag: "meta",
					attrs: {
						name: "theme-color",
						content: "#f5f7f8",
						media: "(prefers-color-scheme: light)",
					},
				},
				{
					tag: "meta",
					attrs: {
						name: "theme-color",
						content: "#0c181c",
						media: "(prefers-color-scheme: dark)",
					},
				},
				{ tag: "script", content: analyticsScript },
				{
					tag: "meta",
					attrs: {
						property: "og:image",
						content: "https://recount.cloud/og.png",
					},
				},
				{ tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
				{ tag: "meta", attrs: { property: "og:image:height", content: "630" } },
				{
					tag: "meta",
					attrs: {
						property: "og:image:alt",
						content:
							"Recount: see what your machines were doing, when it mattered",
					},
				},
				{
					tag: "meta",
					attrs: { name: "twitter:card", content: "summary_large_image" },
				},
			],
			sidebar: [
				{
					label: "Start here",
					translations: { fr: "Commencer ici" },
					items: ["docs", "docs/quick-start"],
				},
				{
					label: "Guides",
					items: ["docs/concepts", "docs/collector", "docs/self-hosting"],
				},
			],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
