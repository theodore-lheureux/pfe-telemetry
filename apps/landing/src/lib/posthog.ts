import posthog from "posthog-js";
// Bundle the extensions this site uses: content blockers often block the files
// posthog-js would otherwise download by name, even through our proxy.
import "posthog-js/dist/posthog-recorder";
import "posthog-js/dist/dead-clicks-autocapture";

// Product analytics for recount.cloud only, so previews and local builds are not counted.
const token = import.meta.env.PUBLIC_POSTHOG_PROJECT_TOKEN;
const host = import.meta.env.PUBLIC_POSTHOG_HOST;
const enabled = Boolean(token && host) && location.hostname === "recount.cloud";

export function startAnalytics() {
	if (!enabled || posthog.__loaded) return;
	posthog.init(token, {
		api_host: host,
		// The API host is a reverse proxy; links and the toolbar use the app.
		ui_host: "https://us.posthog.com",
	});
}

export function track(event: string) {
	if (enabled) posthog.capture(event);
}
