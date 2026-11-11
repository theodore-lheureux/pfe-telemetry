import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishWebRuntime, watchesWebSource } from "./web-watch";

const temporary: string[] = [];
afterEach(async () => {
	for (const directory of temporary.splice(0))
		await rm(directory, { recursive: true, force: true });
});

test("source watching excludes generated catalogs, credentials and dependency/build loops", () => {
	for (const path of [
		"components/example.tsx",
		"messages/fr.json",
		"src/brand-assets.ts",
		"emails/organization-invitation.tsx",
	])
		expect(watchesWebSource(path)).toBe(true);
	for (const path of [
		".env",
		"src/paraglide/messages.js",
		"project.inlang/cache/paraglide-js/generated.json",
		"routeTree.gen.ts",
		"node_modules/example/index.js",
		".output/server/index.mjs",
		"dist/index.js",
	])
		expect(watchesWebSource(path)).toBe(false);
});

test("runtime publication is atomic and invalid or native bundles leave the current runtime intact", async () => {
	const directory = await mkdtemp(join(tmpdir(), "recount-web-watch-"));
	temporary.push(directory);
	const source = join(directory, "source");
	const destination = join(directory, "watch");
	await mkdir(join(source, "server"), { recursive: true });
	await mkdir(join(source, "public"));
	await writeFile(join(source, "nitro.json"), "{}");
	await writeFile(join(source, "server/index.mjs"), "export default 1;");
	const first = await publishWebRuntime(source, destination);
	expect(await readlink(join(destination, "current"))).toBe(`builds/${first}`);
	expect(await readFile(join(destination, "ready"), "utf8")).toBe(`${first}\n`);
	await writeFile(join(source, "server/index.mjs"), "export default 2;");
	const second = await publishWebRuntime(source, destination);
	expect(second).not.toBe(first);
	expect(
		await readFile(join(destination, "current/server/index.mjs"), "utf8"),
	).toBe("export default 2;");
	await writeFile(join(source, "server/addon.node"), "native");
	await expect(publishWebRuntime(source, destination)).rejects.toThrow(
		"JavaScript-only",
	);
	expect(await readlink(join(destination, "current"))).toBe(`builds/${second}`);
	await rm(join(source, "server/addon.node"));
	await writeFile(join(source, "public/.env"), "private");
	await expect(publishWebRuntime(source, destination)).rejects.toThrow();
	expect(await readFile(join(destination, "ready"), "utf8")).toBe(
		`${second}\n`,
	);
});
