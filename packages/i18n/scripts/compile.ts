import { readFile } from "node:fs/promises";
import { compile } from "@inlang/paraglide-js";
import { compilerOptions } from "../config";

const catalog = async (locale: string) =>
	JSON.parse(
		await readFile(
			new URL(`../messages/${locale}.json`, import.meta.url),
			"utf8",
		),
	) as Record<string, string>;
const english = await catalog("en");
const french = await catalog("fr");
if (
	Object.keys(english).length === 0 ||
	Object.keys(english).sort().join() !== Object.keys(french).sort().join()
)
	throw new Error("EN/FR message catalogs must have matching, nonempty keys");
for (const [key, message] of Object.entries(english)) {
	const parameters = (value: string) =>
		[...value.matchAll(/\{(\w+)\}/g)]
			.map((match) => match[1])
			.sort()
			.join();
	if (!french[key] || parameters(message) !== parameters(french[key]))
		throw new Error(`Missing or mismatched French message: ${key}`);
}

await compile({
	...compilerOptions,
	project: new URL("../project.inlang", import.meta.url).pathname,
	outdir: new URL("../src/paraglide", import.meta.url).pathname,
});
const { m } = await import("../src/paraglide/messages.js");
if (m.app_title({}, { locale: "fr" }) !== "PFE Telemetry")
	throw new Error("Compiled catalog smoke check failed");
