import { createLiveGateway } from "../src/activity/live-gateway.server";

const gateway = await createLiveGateway();
const port = Number(process.env.RECOUNT_LIVE_GATEWAY_PORT ?? "3002");
if (!Number.isInteger(port) || port < 1 || port > 65535)
	throw new Error("Invalid Live gateway port");
const server = Bun.serve({
	hostname: process.env.RECOUNT_LIVE_GATEWAY_HOST ?? "127.0.0.1",
	port,
	idleTimeout: 60,
	fetch: gateway.fetch,
});
let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	await gateway.close();
	await server.stop(true);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
console.info(`Live gateway listening on port ${port}`);
