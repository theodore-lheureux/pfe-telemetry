import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	const env = loadEnv(
		mode,
		fileURLToPath(new URL(".", import.meta.url)),
		"WEB_",
	);
	const port = Number(env.WEB_PORT ?? 3001);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		throw new Error("WEB_PORT must be an integer between 1024 and 65535");
	}
	return {
		server: { host: "127.0.0.1", port, strictPort: true },
		resolve: {
			alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
		},
		plugins: [tailwindcss(), tanstackStart(), react()],
	};
});
