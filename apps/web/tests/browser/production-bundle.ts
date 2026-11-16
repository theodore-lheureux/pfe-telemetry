import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serverFunctionPaths } from "../../../../tooling/server-function-metadata";
import { stageWeb } from "../../../../tooling/stage-web";

const bundleEnvironment = "RECOUNT_BROWSER_BUNDLE";

async function fingerprint(root: string): Promise<string> {
	const hash = createHash("sha256");
	async function visit(directory: string) {
		const entries = await readdir(join(root, directory), {
			withFileTypes: true,
		});
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const relative = join(directory, entry.name);
			const path = join(root, relative);
			if (entry.isDirectory()) await visit(relative);
			const content = entry.isSymbolicLink() ? await readlink(path) : "";
			const digest = entry.isFile()
				? createHash("sha256")
						.update(await readFile(path))
						.digest("hex")
				: "";
			hash.update(
				JSON.stringify([relative, entry.isDirectory(), content, digest]),
			);
		}
	}
	await visit("");
	return hash.digest("hex");
}

export function loadProductionBundle(directory: string) {
	const metadata = serverFunctionPaths(
		pathToFileURL(join(directory, "server/_ssr/ssr.mjs")),
	);
	return {
		directory,
		entrypoint: join(directory, "server/index.mjs"),
		serverFunctionPath: metadata,
	};
}

export type ProductionBundle = ReturnType<typeof loadProductionBundle>;

export async function stageProductionBundle(source: string) {
	const temporary = await mkdtemp(join(tmpdir(), "recount-browser-bundle-"));
	const directory = join(temporary, "web");
	const close = () => rm(temporary, { recursive: true, force: true });
	try {
		// Reject a mixed snapshot instead of retrying a racing build.
		const before = await fingerprint(source);
		await stageWeb(directory, source);
		const staged = await fingerprint(directory);
		if (before !== staged || before !== (await fingerprint(source)))
			throw new Error("The production build changed while it was being staged");
		const bundle = loadProductionBundle(directory);
		return { ...bundle, close };
	} catch (cause) {
		await close();
		throw new Error(
			"Cannot stage the production browser bundle: the build is missing, invalid or changing. Run `bun --bun run --cwd apps/web build` and start the tests from a complete build, before another build begins.",
			{ cause },
		);
	}
}

export function productionBundleForWorker(): ProductionBundle | undefined {
	if (process.env.RECOUNT_BROWSER_BUILT !== "true") return;
	const directory = process.env[bundleEnvironment];
	if (!directory)
		throw new Error("Production browser tests require bundle global setup");
	return loadProductionBundle(directory);
}

export default async function setupProductionBundle() {
	if (process.env.RECOUNT_BROWSER_BUILT !== "true") return;
	const bundle = await stageProductionBundle(
		fileURLToPath(new URL("../../.output", import.meta.url)),
	);
	const previous = process.env[bundleEnvironment];
	process.env[bundleEnvironment] = bundle.directory;
	return async () => {
		if (previous === undefined) delete process.env[bundleEnvironment];
		else process.env[bundleEnvironment] = previous;
		await bundle.close();
	};
}
