import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";
import { validatePublicAssets } from "../../infra/local/artifacts.ts";
import { compilerOptions } from "../../packages/i18n/config.ts";
import { drainProcessAuthEmailDelivery } from "./src/auth/email-delivery.server.ts";

export default defineConfig(({ mode }) => {
	const env = loadEnv(
		mode,
		fileURLToPath(new URL(".", import.meta.url)),
		"RECOUNT_",
	);
	const port = Number(env.RECOUNT_WEB_PORT ?? 3001);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		throw new Error(
			"RECOUNT_WEB_PORT must be an integer between 1024 and 65535",
		);
	}
	return {
		server: { host: "127.0.0.1", port, strictPort: true },
		// Preserve Better Auth's dependency-local Zod resolution in server output.
		ssr: {
			external: ["better-auth"],
			noExternal: ["@recount/i18n", "@recount/transactional"],
		},
		resolve: {
			alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
		},
		plugins: [
			{
				name: "recount-public-artifact-boundary",
				buildStart() {
					if (this.environment.name === "client")
						validatePublicAssets(
							fileURLToPath(new URL("./public", import.meta.url)),
						);
				},
			},
			{
				name: "recount-auth-email-lifecycle",
				closeServer: ({ reason }) =>
					drainProcessAuthEmailDelivery(reason === "close"),
				closePreviewServer: () => drainProcessAuthEmailDelivery(true),
			},
			paraglideVitePlugin({
				...compilerOptions,
				project: "../../packages/i18n/project.inlang",
				outdir: "../../packages/i18n/src/paraglide",
			}),
			tailwindcss(),
			tanstackStart({ importProtection: { behavior: "error" } }),
			react(),
			nitro({
				preset: "bun",
				serverEntry: "./src/hosting/options.ts",
				deps: { install: false },
				routeRules: {
					"/**": { headers: { "X-Content-Type-Options": "nosniff" } },
					"/assets/**": {
						headers: { "Cache-Control": "public, max-age=31536000, immutable" },
					},
				},
				hooks: {
					compiled(nitro) {
						validatePublicAssets(nitro.options.output.publicDir);
					},
				},
			}),
		],
	};
});
