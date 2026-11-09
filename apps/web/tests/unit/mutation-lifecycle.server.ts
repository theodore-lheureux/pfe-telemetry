const bundle = await Bun.build({
	entrypoints: [
		new URL("./mutation-lifecycle.fixture.tsx", import.meta.url).pathname,
	],
	target: "browser",
});
if (!bundle.success)
	throw new AggregateError(bundle.logs, "Mutation fixture build failed");
Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.RECOUNT_MUTATION_BROWSER_PORT ?? 3964),
	fetch(request) {
		if (new URL(request.url).pathname === "/fixture.js")
			return new Response(bundle.outputs[0], {
				headers: { "Content-Type": "text/javascript" },
			});
		return new Response(
			'<!doctype html><html lang="en"><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
			{ headers: { "Content-Type": "text/html" } },
		);
	},
});
