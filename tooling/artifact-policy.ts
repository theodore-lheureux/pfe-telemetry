import {
	existsSync,
	lstatSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export function linuxArchitecture(
	header: Uint8Array,
	mode: number,
): "amd64" | "arm64" {
	if (
		header.length < 20 ||
		Buffer.from(header.subarray(0, 7)).toString("hex") !== "7f454c46020101" ||
		![0, 3].includes(header[7])
	)
		throw new Error("Expected a 64-bit little-endian Linux ELF artifact");
	if (!(mode & 0o111)) throw new Error("Linux artifact must be executable");
	const machine = new DataView(
		header.buffer,
		header.byteOffset,
		header.byteLength,
	).getUint16(18, true);
	if (machine === 62) return "amd64";
	if (machine === 183) return "arm64";
	throw new Error("Unsupported Linux ELF architecture");
}

export function validateElf(
	header: Uint8Array,
	mode: number,
	arch: string,
): void {
	if (linuxArchitecture(header, mode) !== arch)
		throw new Error("Linux ELF architecture differs from the build target");
}

export function inside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith("../") && !isAbsolute(child);
}

export function validateWeb(
	root: string,
	directory = root,
	seen = new Set<string>(),
): void {
	const boundary = realpathSync(root);
	const canonical = realpathSync(directory);
	if (!inside(boundary, canonical))
		throw new Error("Runtime workspace symlink escapes its staging directory");
	if (seen.has(canonical)) return;
	seen.add(canonical);
	for (const name of readdirSync(directory)) {
		if (
			name === ".env" ||
			name.startsWith(".env.") ||
			name.endsWith(".token") ||
			["id_rsa", "id_ed25519"].includes(name)
		)
			throw new Error(
				"Private configuration/key/token files must not enter runtime staging",
			);
		const path = join(directory, name);
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() && !inside(boundary, realpathSync(path)))
			throw new Error(
				"Runtime workspace symlink escapes its staging directory",
			);
		if (statSync(path).isDirectory()) validateWeb(boundary, path, seen);
	}
}

export function validateWebRuntime(root: string) {
	for (const file of ["server/index.mjs", "nitro.json"]) {
		if (!statSync(join(root, file)).isFile())
			throw new Error("Host-built web runtime inputs are required");
	}
	if (
		existsSync(join(root, "packages")) ||
		existsSync(join(root, "server/node_modules/@recount"))
	)
		throw new Error("Owned workspace packages must be bundled, not staged");
	validateWeb(root);
	validatePublicAssets(join(root, "public"));
}

export function validatePublicAssets(root: string): void {
	if (lstatSync(root).isSymbolicLink())
		throw new Error("Public asset root must not be a symlink");
	validateWeb(root);
	function visit(directory: string) {
		for (const name of readdirSync(directory)) {
			const path = join(directory, name);
			const isDirectory = statSync(path).isDirectory();
			// Nitro decodes asset IDs once and negotiates one lowercase compression suffix.
			const decoded = decodeURIComponent(name);
			if (/[\\/]/.test(decoded) || decoded === "." || decoded === "..")
				throw new Error(
					"Ambiguous public asset separators or dot segments are not allowed",
				);
			const logicalNames = isDirectory
				? [decoded]
				: [decoded, decoded.replace(/\.(?:gz|br|zst)$/, "")];
			for (const logicalName of logicalNames) {
				if (
					logicalName.startsWith(".") ||
					logicalName.endsWith(".token") ||
					["id_rsa", "id_ed25519"].includes(logicalName) ||
					/\.(?:map|[cm]?ts|tsx|jsx|json)$/i.test(logicalName) ||
					(directory === root && /\.html?$/i.test(logicalName)) ||
					["src", "server", "node_modules", "packages"].includes(logicalName)
				)
					throw new Error(
						"Private source/configuration or HTML must not enter public assets",
					);
			}
			if (isDirectory) visit(path);
		}
	}
	visit(root);
}
