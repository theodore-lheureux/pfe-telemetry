import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { compilerOptions } from "../../packages/i18n/config.ts";

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
		// Preserve Better Auth's dependency-local Zod resolution in server output.
		ssr: { external: ["better-auth"] },
		resolve: {
			alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
		},
		plugins: [
			paraglideVitePlugin({
				...compilerOptions,
				project: "../../packages/i18n/project.inlang",
				outdir: "../../packages/i18n/src/paraglide",
			}),
			tailwindcss(),
			tanstackStart({ importProtection: { behavior: "error" } }),
			react(),
		],
	};
});
