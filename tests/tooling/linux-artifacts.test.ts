import { expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { linuxPlatform } from "../linux-artifacts";

test("Linux artifact platform follows the executable, not the build host", async () => {
	const directory = await mkdtemp(join(tmpdir(), "recount-tooling-elf-"));
	const path = join(directory, "binary");
	try {
		await writeFile(path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
		await expect(linuxPlatform(path)).rejects.toThrow("Linux ELF");
		for (const [machine, platform] of [
			[62, "linux/amd64"],
			[183, "linux/arm64"],
		] as const) {
			const header = Buffer.alloc(20);
			header.set([127, 69, 76, 70, 2, 1, 1]);
			header.writeUInt16LE(machine, 18);
			await writeFile(path, header);
			await chmod(path, 0o755);
			expect(await linuxPlatform(path)).toBe(platform);
			await chmod(path, 0o644);
			await expect(linuxPlatform(path)).rejects.toThrow("executable");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

for (const failed of ["", "build", "run"] as const) {
	test(`Linux runner snapshots host artifacts and cleans owned state after ${failed || "success"}`, async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "recount-tooling-runner-")),
		);
		try {
			const binary = join(directory, "test-binary");
			const companion = join(directory, "companion-binary");
			const header = Buffer.alloc(20);
			header.set([127, 69, 76, 70, 2, 1, 1]);
			header.writeUInt16LE(183, 18);
			for (const path of [binary, companion]) {
				await writeFile(path, header);
				await chmod(path, 0o755);
			}
			const buildLog = join(directory, "artifacts.jsonl");
			await writeFile(
				buildLog,
				[
					{
						reason: "compiler-artifact",
						executable: binary,
						profile: { test: true },
					},
					{
						reason: "compiler-artifact",
						executable: companion,
						profile: { test: false },
					},
				]
					.map((event) => JSON.stringify(event))
					.join("\n"),
			);
			const commands = join(directory, "commands.jsonl");
			const bin = join(directory, "bin");
			await mkdir(bin);
			await writeFile(
				join(bin, "docker"),
				`#!/usr/bin/env bun
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const record = { args };
if (args[0] === "build") {
  const context = args.at(-1);
  record.context = context;
  record.dockerfile = await readFile(join(context, "Dockerfile"), "utf8");
  record.bytes = [];
  for (const path of JSON.parse(process.env.RECOUNT_TEST_ARTIFACTS))
    record.bytes.push([...await readFile(join(context, "rootfs", path.slice(1)))]);
}
await appendFile(process.env.RECOUNT_TEST_DOCKER_LOG, JSON.stringify(record) + "\\n");
process.exit(args[0] === process.env.RECOUNT_TEST_DOCKER_FAIL ? 17 : 0);
`,
			);
			await chmod(join(bin, "docker"), 0o755);
			const child = Bun.spawn(
				[
					process.execPath,
					fileURLToPath(new URL("../linux-artifacts.ts", import.meta.url)),
					buildLog,
				],
				{
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						RECOUNT_TEST_DOCKER_LOG: commands,
						RECOUNT_TEST_DOCKER_FAIL: failed,
						RECOUNT_TEST_ARTIFACTS: JSON.stringify([binary, companion]),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [code, output, errors] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code, output + errors).toBe(failed ? 17 : 0);
			const recorded = (await readFile(commands, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(recorded.map((item) => item.args[0])).toEqual(
				failed === "build" ? ["build", "rm"] : ["build", "run", "rm"],
			);
			const build = recorded[0];
			expect(build.args).toContain("linux/arm64");
			expect(build.dockerfile).not.toMatch(/^RUN\s/m);
			expect(build.bytes).toEqual([[...header], [...header]]);
			expect(await Bun.file(join(build.context, "Dockerfile")).exists()).toBe(
				false,
			);
			const cleanup = recorded.at(-1).args;
			expect(cleanup.slice(0, 2)).toEqual(["rm", "--force"]);
			if (failed !== "build") {
				const args = recorded[1].args as string[];
				const value = (flag: string) => args[args.indexOf(flag) + 1];
				expect(value("--name")).toBe(cleanup[2]);
				expect(value("--platform")).toBe("linux/arm64");
				expect(value("--network")).toBe("none");
				expect(args).toContain("--read-only");
				expect(value("--memory")).toBe("384m");
				expect(value("--memory-swap")).toBe("384m");
				expect(value("--cpus")).toBe("1");
				expect(value("--pids-limit")).toBe("128");
				expect(value("--cap-drop")).toBe("ALL");
				expect(value("--security-opt")).toBe("no-new-privileges");
				expect(args).not.toContain("--mount");
				const scratch = value("--env").slice("TMPDIR=".length);
				expect(value("--tmpfs")).toBe(`${scratch}:rw,nosuid,nodev,size=64m`);
				expect(
					[binary, companion].every((path) => !path.startsWith(`${scratch}/`)),
				).toBe(true);
				expect(args.at(-1)).toBe(binary);
				expect(args).not.toContain(companion);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
