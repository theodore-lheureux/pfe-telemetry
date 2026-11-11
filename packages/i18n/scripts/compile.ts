import { compile } from "@inlang/paraglide-js";
import { compilerOptions } from "../config";
import { validateMessageCatalogs } from "./catalogs";

await validateMessageCatalogs();

await compile({
	...compilerOptions,
	project: new URL("../project.inlang", import.meta.url).pathname,
	outdir: new URL("../src/paraglide", import.meta.url).pathname,
});
const { m } = await import("../src/paraglide/messages.js");
if (m.app_title({}, { locale: "fr" }) !== "Recount")
	throw new Error("Compiled catalog smoke check failed");
