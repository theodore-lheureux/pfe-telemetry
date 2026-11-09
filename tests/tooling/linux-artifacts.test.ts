import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
