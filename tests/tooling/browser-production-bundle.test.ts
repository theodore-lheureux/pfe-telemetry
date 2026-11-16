import { afterEach, expect, spyOn, test } from "bun:test";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadProductionBundle,
	productionBundleForWorker,
	stageProductionBundle,
} from "../../apps/web/tests/browser/production-bundle";
import { publishWebRuntime } from "../../infra/local/web-watch";
import * as webStaging from "../../tooling/stage-web";

const temporary: string[] = [];
afterEach(async () => {
	for (const path of temporary.splice(0))
		await rm(path, { recursive: true, force: true });
});

async function createBuild() {
	const source = await mkdtemp(join(tmpdir(), "recount-browser-source-"));
	temporary.push(source);
	await mkdir(join(source, "server/_ssr"), { recursive: true });
	await mkdir(join(source, "public"));
	await writeFile(join(source, "nitro.json"), "{}");
	await writeFile(join(source, "server/index.mjs"), 'export default "first";');
	await writeFile(join(source, "public/asset.js"), 'console.log("first");');
	await writeFile(
		join(source, "server/_ssr/ssr.mjs"),
		`throw new Error("metadata must not execute");
const manifest = { "first": { functionName: "read_createServerFn_handler" } };`,
	);
	return source;
}

test("one staged bundle keeps its entrypoint, assets and RPC metadata across source rebuilds", async () => {
	const source = await createBuild();
	const bundle = await stageProductionBundle(source);
	const published = await mkdtemp(join(tmpdir(), "recount-browser-published-"));
	temporary.push(published);
	try {
		await rm(join(source, "server"), { recursive: true });
		await writeFile(join(source, "public/asset.js"), 'console.log("second");');
		const worker = loadProductionBundle(bundle.directory);
		expect(worker.serverFunctionPath("read")).toBe("/_serverFn/first");
		expect(await readFile(worker.entrypoint, "utf8")).toContain('"first"');
		await mkdir(join(source, "server/_ssr"), { recursive: true });
		await writeFile(
			join(source, "server/index.mjs"),
			'export default "second";',
		);
		await writeFile(
			join(source, "server/_ssr/ssr.mjs"),
			`const manifest = { "second": { functionName: "read_createServerFn_handler" } };`,
		);
		const publication = await publishWebRuntime(source, published);
		expect(await readlink(join(published, "current"))).toBe(
			`builds/${publication}`,
		);
		// A replacement worker must still parse the run's bundle after publication.
		const replacement = loadProductionBundle(bundle.directory);
		expect(replacement.serverFunctionPath("read")).toBe("/_serverFn/first");
		expect(await readFile(replacement.entrypoint, "utf8")).toContain('"first"');
		expect(
			await readFile(join(worker.directory, "public/asset.js"), "utf8"),
		).toContain('"first"');
		expect(worker.directory).toBe(bundle.directory);
		expect(() => worker.serverFunctionPath("missing")).toThrow("Expected one");
	} finally {
		await bundle.close();
	}
	await expect(access(bundle.directory)).rejects.toThrow();
	expect(await readFile(join(source, "public/asset.js"), "utf8")).toContain(
		'"second"',
	);
});

test("missing builds, entrypoints and metadata fail during staging without retrying", async () => {
	const source = await createBuild();
	const staging = await mkdtemp(join(tmpdir(), "recount-browser-failed-"));
	temporary.push(staging);
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = staging;
	try {
		await expect(
			stageProductionBundle(join(source, "missing")),
		).rejects.toThrow("Cannot stage");
		await rm(join(source, "server/index.mjs"));
		await expect(stageProductionBundle(source)).rejects.toThrow("Cannot stage");
		await writeFile(join(source, "server/index.mjs"), "export default 1;");
		await rm(join(source, "server/_ssr/ssr.mjs"));
		await expect(stageProductionBundle(source)).rejects.toThrow("Cannot stage");
		await writeFile(join(source, "server/_ssr/ssr.mjs"), "export default {};");
		await expect(stageProductionBundle(source)).rejects.toThrow("Cannot stage");
		expect(await readdir(staging)).toEqual([]);
	} finally {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
	}
});

test("production workers require the run-owned bundle instead of falling back to output", () => {
	const built = process.env.RECOUNT_BROWSER_BUILT;
	const bundle = process.env.RECOUNT_BROWSER_BUNDLE;
	delete process.env.RECOUNT_BROWSER_BUNDLE;
	try {
		process.env.RECOUNT_BROWSER_BUILT = "true";
		expect(() => productionBundleForWorker()).toThrow("bundle global setup");
		process.env.RECOUNT_BROWSER_BUILT = "false";
		expect(productionBundleForWorker()).toBeUndefined();
	} finally {
		if (built === undefined) delete process.env.RECOUNT_BROWSER_BUILT;
		else process.env.RECOUNT_BROWSER_BUILT = built;
		if (bundle === undefined) delete process.env.RECOUNT_BROWSER_BUNDLE;
		else process.env.RECOUNT_BROWSER_BUNDLE = bundle;
	}
});

test("staging rejects runtime links to mutable files outside the bundle", async () => {
	const source = await createBuild();
	const external = await mkdtemp(join(tmpdir(), "recount-browser-external-"));
	temporary.push(external);
	await writeFile(join(external, "chunk.mjs"), "export default 1;");
	await symlink(join(external, "chunk.mjs"), join(source, "server/chunk.mjs"));
	await expect(stageProductionBundle(source)).rejects.toThrow("Cannot stage");
	expect(await readFile(join(external, "chunk.mjs"), "utf8")).toBe(
		"export default 1;",
	);
});

test("a build changing during the copy fails staging instead of accepting a mixed snapshot", async () => {
	const source = await createBuild();
	const copy = webStaging.stageWeb;
	const racingCopy = spyOn(webStaging, "stageWeb").mockImplementation(
		async (destination, input) => {
			await copy(destination, input);
			await writeFile(
				join(source, "server/index.mjs"),
				'export default "replacement";',
			);
		},
	);
	try {
		await expect(stageProductionBundle(source)).rejects.toMatchObject({
			cause: {
				message: "The production build changed while it was being staged",
			},
		});
	} finally {
		racingCopy.mockRestore();
	}
});
