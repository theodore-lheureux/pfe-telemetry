import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { linuxArchitecture } from "../tooling/artifact-policy";

export async function linuxPlatform(path: string) {
	const file = await open(path, "r");
	const header = Buffer.alloc(20);
	let length: number;
	try {
		length = (await file.read(header, 0, 20, 0)).bytesRead;
	} finally {
		await file.close();
	}
	return `linux/${linuxArchitecture(header.subarray(0, length), (await stat(path)).mode)}`;
}

if (import.meta.main) {
	const log = process.argv[2];
	if (!log || process.argv.length !== 3)
		throw new Error(
			"Usage: bun tests/linux-artifacts.ts <Cargo --no-run JSON log>",
		);
	const artifacts = new Map<string, boolean>();
	for (const line of (await readFile(log, "utf8"))
		.split("\n")
		.filter(Boolean)) {
		const event = JSON.parse(line);
		if (event.reason === "compiler-artifact" && event.executable) {
			const path = await realpath(event.executable);
			artifacts.set(path, artifacts.get(path) || event.profile.test);
		}
	}
	const tests = [...artifacts].filter(([, test]) => test).map(([path]) => path);
	if (!tests.length) throw new Error("Cargo log contains no test harnesses");
	const platform = await linuxPlatform(tests[0]);
	for (const path of artifacts.keys())
		if ((await linuxPlatform(path)) !== platform)
			throw new Error("Linux artifact architectures differ");
	const directory = await mkdtemp(join(tmpdir(), "recount-linux-artifacts-"));
	const container = `recount-linux-tests-${randomUUID()}`;
	const scratch = `/${container}-tmp`;
	try {
		const dockerfile =
			"FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895\n" +
			"COPY --chmod=0555 rootfs/ /\n";
		const hash = createHash("sha256").update(dockerfile);
		for (const binary of [...artifacts.keys()].sort()) {
			const bytes = await readFile(binary);
			// Keep embedded Cargo executable paths, but execute from Linux storage rather than a host bind mount.
			const destination = join(directory, "rootfs", binary.slice(1));
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, bytes);
			hash.update(binary).update("\0").update(bytes);
		}
		await writeFile(join(directory, "Dockerfile"), dockerfile);
		const image = `recount-linux-tests:${hash.digest("hex")}`;
		const commands = [
			["build", "--platform", platform, "--tag", image, directory],
			[
				"run",
				"--rm",
				"--name",
				container,
				"--platform",
				platform,
				"--network",
				"none",
				"--read-only",
				"--cpus",
				"1",
				"--memory",
				"384m",
				"--memory-swap",
				"384m",
				"--pids-limit",
				"128",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				// Cargo outputs may live under /tmp; do not hide them with the scratch mount.
				"--tmpfs",
				`${scratch}:rw,nosuid,nodev,size=64m`,
				"--env",
				`TMPDIR=${scratch}`,
				image,
				"/bin/sh",
				"-ec",
				'for binary do printf "Linux harness: %s\\n" "$binary"; "$binary"; done',
				"recount-linux-tests",
				...tests,
			],
		];
		for (const args of commands) {
			const child = Bun.spawn(["docker", ...args], {
				stdin: "ignore",
				stdout: "inherit",
				stderr: "inherit",
			});
			const code = await child.exited;
			if (code !== 0) {
				process.exitCode = code;
				break;
			}
		}
	} finally {
		try {
			// A disconnected Docker client may still have created this exact owned container.
			Bun.spawnSync(["docker", "rm", "--force", container], {
				stdout: "ignore",
				stderr: "ignore",
				timeout: 15_000,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
