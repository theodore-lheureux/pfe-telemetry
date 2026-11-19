import { once } from "node:events";
import { createServer, request } from "node:http";
import { createPointFixture } from "../telemetry/fixture";
import { test as base } from "./fixtures";

export const telemetryTest = base.extend<{
	telemetry: Awaited<ReturnType<typeof createPointFixture>>;
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture arguments.
	telemetry: async ({}, use) => {
		const fixture = await createPointFixture({ participants: true });
		try {
			await use(fixture);
		} finally {
			await fixture.close();
		}
	},
	workspaceEnvironment: async ({ telemetry }, use) => {
		// Map the fixed application reader to this test's SELECT-only account.
		const config = telemetry.readerConfig;
		const server = createServer((incoming, outgoing) => {
			const url = new URL(incoming.url ?? "/", config.url);
			url.searchParams.set("database", config.database);
			const upstream = request(
				url,
				{
					method: incoming.method,
					headers: {
						...incoming.headers,
						host: url.host,
						authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
					},
				},
				(response) => {
					outgoing.writeHead(response.statusCode ?? 500, response.headers);
					response.pipe(outgoing);
				},
			);
			upstream.on("error", () => {
				outgoing.writeHead(502);
				outgoing.end();
			});
			incoming.pipe(upstream);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("Expected test port");
			await use({
				RECOUNT_CLICKHOUSE_URL: `http://127.0.0.1:${address.port}`,
				RECOUNT_CLICKHOUSE_READER_PASSWORD: "fixture",
			});
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
});
