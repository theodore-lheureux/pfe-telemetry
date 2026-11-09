import { open, readFile, realpath, stat } from "node:fs/promises";

export async function linuxPlatform(path: string) {
	const file = await open(path, "r");
	const header = Buffer.alloc(20);
	let length: number;
	try {
		length = (await file.read(header, 0, 20, 0)).bytesRead;
	} finally {
		await file.close();
	}
	if (
		length !== 20 ||
		!header.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) ||
		![0, 3].includes(header[7])
	)
		throw new Error("Expected a 64-bit little-endian Linux ELF artifact");
	if (!((await stat(path)).mode & 0o111))
		throw new Error("Linux artifact must be executable");
	const machine = header.readUInt16LE(18);
	if (machine === 62) return "linux/amd64";
	if (machine === 183) return "linux/arm64";
	throw new Error("Unsupported Linux ELF architecture");
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
	for (const path of tests) {
		const child = Bun.spawn(
			[
				"docker",
				"run",
				"--rm",
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
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,size=64m",
				...[...artifacts.keys()].flatMap((binary) => [
					"--mount",
					`type=bind,src=${binary},dst=${binary},readonly`,
				]),
				"oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895",
				path,
			],
			{ stdin: "ignore", stdout: "inherit", stderr: "inherit" },
		);
		const code = await child.exited;
		if (code !== 0) process.exit(code);
	}
}
