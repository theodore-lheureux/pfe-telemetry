import { defineServerEntry } from "nitro";

export default defineServerEntry({
	gracefulShutdown: { gracefulTimeout: 15 },
	bun: { idleTimeout: 60 },
});
