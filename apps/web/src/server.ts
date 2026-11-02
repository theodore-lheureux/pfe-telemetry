import { paraglideMiddleware } from "@pfe/i18n/server";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

export default createServerEntry({
	async fetch(request, options) {
		return paraglideMiddleware(request, async () => {
			const response = await handler.fetch(request, options);
			const headers = new Headers(response.headers);
			headers.set("Cache-Control", "private, no-store");
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		});
	},
});
