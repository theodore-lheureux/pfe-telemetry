import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePublicAssets } from "../../../../tooling/artifact-policy";

test("public artifacts reject private inputs, HTML route takeovers and escaping symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "recount-public-"));
	const privateRoot = await mkdtemp(join(tmpdir(), "recount-private-"));
	try {
		await mkdir(join(root, "assets"));
		await writeFile(join(root, "assets/app-hash.js"), "export default 'é';");
		await writeFile(join(root, "favicon.svg"), "<svg/>");
		validatePublicAssets(root);
		for (const path of [
			".env",
			"secret.token",
			"app.js.map",
			"index.html",
			"server.ts",
			"config.json",
		]) {
			await writeFile(join(root, path), "private");
			expect(() => validatePublicAssets(root), path).toThrow();
			await rm(join(root, path));
		}
		await writeFile(join(privateRoot, "secret.js"), "private");
		await symlink(privateRoot, join(root, "redirected-public"));
		expect(() => validatePublicAssets(join(root, "redirected-public"))).toThrow(
			"root",
		);
		await rm(join(root, "redirected-public"));
		await symlink(join(privateRoot, "secret.js"), join(root, "escaped.js"));
		expect(() => validatePublicAssets(root)).toThrow("escapes");
	} finally {
		await rm(root, { recursive: true });
		await rm(privateRoot, { recursive: true });
	}
});

test("public policy applies to Nitro's decoded IDs and negotiated compression aliases", async () => {
	const root = await mkdtemp(join(tmpdir(), "recount-public-names-"));
	try {
		await mkdir(join(root, "brand"));
		for (const name of ["%61pp.js", "percent%25.svg", "index%252ehtml"]) {
			await writeFile(join(root, name), "public");
		}
		for (const suffix of ["gz", "br", "zst"]) {
			await writeFile(join(root, `app.js.${suffix}`), "public");
			await writeFile(join(root, `brand/index.html.${suffix}`), "public");
		}
		validatePublicAssets(root);
		for (const name of [
			"app.js.map.gz",
			"app.js.map.br",
			"app.js.map.zst",
			"index.html.gz",
			"index.html.br",
			"index.html.zst",
			"%2eenv",
			"app.js%2emap",
			"app.js%2emap%2egz",
			"config%2ejson.br",
			"secret%2etoken.gz",
			"id_%72sa.zst",
			"%2e",
			"%2e%2e",
			"brand%2fapp.js",
			"brand%5capp.js",
			"bad%GG.js",
		]) {
			await writeFile(join(root, name), "private");
			expect(() => validatePublicAssets(root), name).toThrow();
			await rm(join(root, name));
		}
		for (const name of ["%73rc", "brand%2f..", "%2e%2e"]) {
			await mkdir(join(root, name));
			await writeFile(join(root, name, "app.js"), "private");
			expect(() => validatePublicAssets(root), name).toThrow();
			await rm(join(root, name), { recursive: true });
		}
	} finally {
		await rm(root, { recursive: true });
	}
});
