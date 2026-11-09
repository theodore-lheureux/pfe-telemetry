import { type Lang, localePath } from "../i18n";

// Address of the Recount web app, set with PUBLIC_APP_URL at build time. While it is unset or
// empty, links into the app go to the coming soon page instead.
export const APP_URL: string | undefined =
	import.meta.env.PUBLIC_APP_URL || undefined;

export function appHref(lang: Lang) {
	return APP_URL ?? localePath(lang, "/coming-soon/");
}
// Turnstile site key for the early access form (public). The widget only accepts recount.cloud;
// other hosts use Cloudflare's always-passing test key.
export const TURNSTILE_SITE_KEY = "0x4AAAAAAF5saUgthVLrgwUX";
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";

export const GITHUB_URL = "https://github.com/theodore-lheureux/pfe-telemetry";
export const INGEST_URL = "https://ca.ingest.recount.cloud";

// Shared with Starlight so the landing page and docs keep the same theme choice:
// "light", "dark", or "" to follow the system.
export const THEME_KEY = "starlight-theme";

// Icons are Lucide (lucide.dev, ISC licence), the icon set the Tide Core kit uses; each is
// the inner markup of a 24×24 stroke SVG.
export const icons = {
	refresh:
		'<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />',
	code: '<polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />',
	lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />',
	target:
		'<circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />',
	users:
		'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />',
	check: '<path d="M20 6 9 17l-5-5" />',
	cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />',
	server:
		'<rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" /><line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" />',
	mail: '<rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />',
	shield:
		'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />',
	eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" /><circle cx="12" cy="12" r="3" />',
	monitor:
		'<rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" />',
	sun: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />',
	moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />',
	menu: '<line x1="4" x2="20" y1="6" y2="6" /><line x1="4" x2="20" y1="12" y2="12" /><line x1="4" x2="20" y1="18" y2="18" />',
	x: '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
	chevron: '<path d="m6 9 6 6 6-6" />',
	link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />',
	globe:
		'<circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />',
};

// Icon for each feature, in the order of the features copy.
export const featureIcons = [
	icons.refresh,
	icons.code,
	icons.lock,
	icons.target,
	icons.users,
	icons.check,
];

export function buttonClass(variant: "primary" | "outline", extra = "") {
	const base =
		"inline-flex h-8 items-center justify-center gap-2 rounded-md border px-3 font-medium whitespace-nowrap transition-colors";
	const styles =
		variant === "primary"
			? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
			: "bg-card text-foreground hover:bg-secondary";
	return `${base} ${styles} ${extra}`;
}
