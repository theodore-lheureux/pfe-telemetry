const bundle = await Bun.build({
	entrypoints: [
		new URL("./developer-toolbar.fixture.tsx", import.meta.url).pathname,
	],
	target: "browser",
	plugins: [
		{
			name: "local-developer-rpc-fixture",
			setup(build) {
				build.onLoad(
					{ filter: /developer\/developer\.functions\.ts$/ },
					() => ({
						loader: "js",
						contents: `
					const rpc = (name) => async ({data}) => {
						const response = await fetch("/fixture-rpc/" + name, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data)});
						if (!response.ok) throw new Error("Fixture transport failure");
						return response.json();
					};
					export const developerTasks = rpc("tasks");
					export const developerOutput = rpc("output");
					export const runDeveloperWorkflow = rpc("run");
				`,
					}),
				);
			},
		},
	],
});
if (!bundle.success)
	throw new AggregateError(bundle.logs, "Developer fixture build failed");
Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.RECOUNT_DEVELOPER_BROWSER_PORT ?? 3965),
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
