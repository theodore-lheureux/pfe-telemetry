// `astro check` and its Volar dependencies load `typescript` from the workspace root, where it
// is the native TypeScript 7 compiler without the language-service API they need. Load this
// package's TypeScript 6 and register it under the root path in the shared CommonJS cache, so
// their `require("typescript")` returns it. Works under Node and Bun.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const typescript = require.resolve("typescript");
require(typescript);

const serverRequire = createRequire(
	require.resolve("@astrojs/language-server"),
);
const rootTypescript = serverRequire.resolve("typescript");
if (rootTypescript !== typescript) {
	require.cache[rootTypescript] = require.cache[typescript];
}

const { AstroCheck } = require("@astrojs/language-server");
const root = fileURLToPath(new URL("..", import.meta.url));
const checker = new AstroCheck(root, typescript, undefined);
const result = await checker.lint({ logErrors: { level: "hint" } });

console.info(
	`${result.fileChecked} files: ${result.errors} errors, ${result.warnings} warnings, ${result.hints} hints`,
);
process.exit(result.errors > 0 || result.warnings > 0 ? 1 : 0);
