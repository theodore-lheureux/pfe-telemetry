import { watch } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	open,
	readdir,
	readlink,
	rename,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateWebRuntime } from "../../tooling/artifact-policy";

const root = resolve(import.meta.dir, "../..");
const local = import.meta.dir;
const state = join(root, ".state/local-web-watch");

export function watchesWebSource(path: string): boolean {
	const parts = path.replaceAll("\\", "/").split("/");
	return !parts.some(
		(part) =>
			part.startsWith(".") ||
			[
				"node_modules",
				"paraglide",
				"cache",
				"dist",
				"test-results",
				"routeTree.gen.ts",
			].includes(part),
	);
}

async function rejectNativeRuntime(directory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory())
			await rejectNativeRuntime(join(directory, entry.name));
		else if (/\.(node|dylib|so)(\.|$)/.test(entry.name))
			throw new Error(
				"Host-to-container web watch requires JavaScript-only runtime dependencies; build native runtime dependencies for the Linux target instead.",
			);
	}
}

export async function publishWebRuntime(source: string, destination: string) {
	validateWebRuntime(source);
	await rejectNativeRuntime(source);
	const id = crypto.randomUUID();
	const relative = `builds/${id}`;
	await mkdir(join(destination, "builds"), { recursive: true });
	await cp(source, join(destination, relative), {
		recursive: true,
		verbatimSymlinks: true,
	});
	validateWebRuntime(join(destination, relative));
	const current = join(destination, "current");
	try {
		if (
			!(await lstat(current)).isSymbolicLink() ||
			!/^builds\/[a-f0-9-]+$/.test(await readlink(current))
		)
			throw new Error(
				"Refusing to replace an unrelated web-watch runtime path",
			);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	const next = join(destination, `next-${id}`);
	await symlink(relative, next);
	await rename(next, current);
	await writeFile(join(destination, "ready"), `${id}\n`);
	return id;
}

async function main() {
	await mkdir(state, { recursive: true });
	const lockPath = join(state, "watch.lock");
	const lock = await open(lockPath, "wx").catch(() => {
		throw new Error(
			"A web watcher already owns .state/local-web-watch/watch.lock. Stop it first; remove a stale lock only after verifying its recorded PID is no longer running.",
		);
	});
	await lock.writeFile(`${process.pid}\n`);
	let stopped = false;
	let changed = true;
	let building = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let build: ReturnType<typeof Bun.spawn> | undefined;
	let composeWatch: ReturnType<typeof Bun.spawn> | undefined;
	const watchers: ReturnType<typeof watch>[] = [];
	const composeFiles = [
		...new Set([
			...(process.env.COMPOSE_FILE ?? "compose.yaml").split(":"),
			"compose.apps.yaml",
			"compose.watch.yaml",
		]),
	];
	const env = { ...process.env, COMPOSE_FILE: composeFiles.join(":") };
	const compose = (...args: string[]) =>
		Bun.spawn(["docker", "compose", ...args], {
			cwd: local,
			env,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});
	const stop = () => {
		stopped = true;
		clearTimeout(timer);
		for (const watcher of watchers) watcher.close();
		composeWatch?.kill("SIGTERM");
		build?.kill("SIGTERM");
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	async function rebuild() {
		if (building || stopped) return;
		building = true;
		try {
			do {
				changed = false;
				console.info("Building web application on the host…");
				build = Bun.spawn(
					["bun", "--no-env-file", "run", "--cwd", "apps/web", "build"],
					{ cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
				);
				const code = await build.exited;
				build = undefined;
				if (stopped) return;
				if (code !== 0) {
					console.error(
						"Web build failed; keeping the last working container bundle.",
					);
					return false;
				}
				if (changed) continue;
				await publishWebRuntime(join(root, "apps/web/.output"), state);
				console.info(
					"Web bundle published; Compose watch will restart web and Live. Refresh your browser after the restart.",
				);
			} while (changed && !stopped);
			return true;
		} finally {
			building = false;
		}
	}
	try {
		for (const directory of [
			"apps/web/src",
			"apps/web/public",
			"packages/i18n",
			"packages/transactional",
			"tooling",
		]) {
			watchers.push(
				watch(
					join(root, directory),
					{ recursive: true },
					(_event, filename) => {
						if (!filename || !watchesWebSource(filename.toString())) return;
						changed = true;
						clearTimeout(timer);
						timer = setTimeout(() => {
							void rebuild().catch((error) =>
								console.error("Web watch rebuild failed:", error.message),
							);
						}, 400);
					},
				),
			);
		}
		for (const file of [
			"bun.lock",
			"package.json",
			"apps/web/package.json",
			"apps/web/vite.config.ts",
			"apps/web/tsconfig.json",
		]) {
			watchers.push(
				watch(join(root, dirname(file)), (_event, filename) => {
					if (filename?.toString() !== file.split("/").at(-1)) return;
					changed = true;
					clearTimeout(timer);
					timer = setTimeout(() => {
						void rebuild().catch((error) =>
							console.error("Web watch rebuild failed:", error.message),
						);
					}, 400);
				}),
			);
		}
		if (!(await rebuild())) {
			if (stopped) return;
			throw new Error(
				"Initial web build failed; the existing web container was not changed",
			);
		}
		if (stopped) return;
		if (
			(await compose(
				"up",
				"--no-build",
				"--no-deps",
				"--detach",
				"--wait",
				"--wait-timeout",
				"90",
				"live",
				"web",
			).exited) !== 0
		)
			throw new Error(
				"Could not start the watched web container; no backends were changed",
			);
		composeWatch = compose("watch", "--no-up", "--prune=false", "web", "live");
		console.info(
			"Watching web sources and shared UI/email catalogs. Only web and Live containers will restart.",
		);
		const code = await composeWatch.exited;
		if (!stopped && code !== 0)
			throw new Error("Compose watch exited unexpectedly");
	} finally {
		stop();
		if (build) await build.exited;
		if (composeWatch) await composeWatch.exited;
		await lock.close();
		await unlink(lockPath);
	}
}

if (import.meta.main) await main();
