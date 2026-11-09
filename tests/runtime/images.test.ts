import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { createAuth } from "../../apps/web/src/auth/create-auth.server";
import { trustedCodeSignIn } from "../../apps/web/tests/auth-actors";
import { createTestDatabase } from "../../apps/web/tests/database";

function required(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
function docker(args: string[], env: Record<string, string | undefined> = {}) {
	return Bun.spawnSync(["docker", ...args], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 45_000,
	});
}
function runOwned(args: string[]) {
	const name = `recount-runtime-smoke-${randomUUID()}`;
	try {
		return docker(["run", "--rm", "--name", name, ...args]);
	} finally {
		// A failed/timed-out Docker client may still have created this exact container.
		docker(["rm", "--force", name]);
	}
}

test("packaged Rust entrypoints run as unprivileged users without a compiler or network", () => {
	expect(required("RECOUNT_RUNTIME_TEST_ALLOW_CONTAINERS")).toBe("1");
	for (const role of ["COLLECTOR", "INGESTION_API", "NORMALIZER"]) {
		const image = required(`RECOUNT_RUNTIME_${role}_IMAGE`);
		const help = runOwned([
			"--network",
			"none",
			"--read-only",
			"--memory",
			"128m",
			"--memory-swap",
			"128m",
			"--cpus",
			"1",
			"--pids-limit",
			"64",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			image,
			"--help",
		]);
		expect(help.exitCode, role).toBe(0);
		expect(help.stdout.toString()).toContain("Usage:");
		const user = runOwned([
			"--network",
			"none",
			"--read-only",
			"--memory",
			"64m",
			"--entrypoint",
			"id",
			image,
			"-u",
		]);
		expect(user.exitCode).toBe(0);
		expect(user.stdout.toString().trim()).not.toBe("0");
	}
}, 90_000);

test("packaged web serves private localized SSR and assets, forces active-body drain and closes owned PG connections", async () => {
	expect(required("RECOUNT_RUNTIME_TEST_ALLOW_CONTAINERS")).toBe("1");
	const host = required("RECOUNT_RUNTIME_DATABASE_HOST");
	const port = required("RECOUNT_RUNTIME_DATABASE_PORT");
	const network = required("RECOUNT_RUNTIME_DATABASE_NETWORK");
	const image = required("RECOUNT_RUNTIME_WEB_IMAGE");
	const database = await createTestDatabase("runtime");
	const name = `recount-web-smoke-${randomUUID()}`;
	const applicationName = `recount-runtime-${randomUUID()}`;
	const url = new URL(database.url);
	url.hostname = host;
	url.port = port;
	url.searchParams.set("application_name", applicationName);
	const environment = {
		DATABASE_URL: url.toString(),
		BETTER_AUTH_SECRET: randomUUID().repeat(2),
		BETTER_AUTH_URL: "http://localhost:3000",
		RECOUNT_AUTH_ALLOW_SIGN_UP: "true",
		SMTP_HOST: "127.0.0.1",
		SMTP_PORT: "31562",
		SMTP_USER: "test-only",
		SMTP_PASSWORD: "test-only",
		EMAIL_FROM: "tests@example.invalid",
	};
	let auth: ReturnType<typeof createAuth> | undefined;
	let socket: Socket | undefined;
	let trickle: ReturnType<typeof setInterval> | undefined;
	let stopTask: Promise<number> | undefined;
	async function connections() {
		return (
			(
				await database.pool.query(
					"SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1",
					[applicationName],
				)
			).rowCount ?? 0
		);
	}
	try {
		const result = docker(
			[
				"run",
				"--detach",
				"--name",
				name,
				"--network",
				network,
				"--publish",
				"127.0.0.1::3000",
				"--read-only",
				"--memory",
				"384m",
				"--memory-swap",
				"384m",
				"--cpus",
				"1",
				"--pids-limit",
				"128",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,size=64m",
				...Object.keys(environment).flatMap((key) => ["--env", key]),
				image,
			],
			environment,
		);
		expect(result.exitCode).toBe(0);
		const port = docker(["port", name, "3000/tcp"]);
		expect(port.exitCode).toBe(0);
		const origin = `http://${port.stdout.toString().trim()}`;
		const deadline = performance.now() + 20_000;
		let status = 0;
		while (status !== 200 && performance.now() < deadline) {
			try {
				const response = await fetch(`${origin}/login`, {
					signal: AbortSignal.timeout(1_000),
				});
				await response.arrayBuffer();
				status = response.status;
			} catch {
				status = 0;
			}
			if (status !== 200) await Bun.sleep(100);
		}
		expect(status).toBe(200);
		let html = "";
		for (const locale of ["en", "fr"]) {
			const response = await fetch(`${origin}/login`, {
				headers: { Cookie: `recount_locale=${locale}` },
			});
			expect(response.status).toBe(200);
			html = await response.text();
			expect(html).toMatch(new RegExp(`<html\\b[^>]*\\blang="${locale}"`));
			for (const secret of [
				environment.DATABASE_URL,
				environment.BETTER_AUTH_SECRET,
			])
				expect(html).not.toContain(secret);
		}
		const asset = html.match(/(?:src|href)="(\/assets\/[^"?]+\.js)"/)?.[1];
		expect(asset).toBeDefined();
		const get = await fetch(`${origin}${asset}`);
		const body = await get.arrayBuffer();
		expect(get.status).toBe(200);
		expect(get.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
		expect(get.headers.get("x-content-type-options")).toBe("nosniff");
		const head = await fetch(`${origin}${asset}`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(Number(head.headers.get("content-length"))).toBe(body.byteLength);
		expect(head.headers.get("content-type")).toBe(
			get.headers.get("content-type"),
		);
		expect((await head.arrayBuffer()).byteLength).toBe(0);
		for (const path of [
			"/.env",
			"/runtime.mjs",
			"/host.mjs",
			"/dist/server/server.js",
			"/server/index.mjs",
			"/.output/server/index.mjs",
			"/packages/transactional/src/index.tsx",
			`${asset}.map`,
		]) {
			const response = await fetch(`${origin}${path}`);
			expect(response.status, path).toBe(404);
			await response.arrayBuffer();
		}
		const malformed = await fetch(`${origin}/%GG`);
		expect(malformed.status).toBe(400);
		await malformed.arrayBuffer();
		expect(
			docker([
				"exec",
				name,
				"sh",
				"-c",
				"test ! -e /app/packages && test ! -e /app/node_modules/@recount",
			]).exitCode,
		).toBe(0);

		const codes = new Map<string, string>();
		auth = createAuth(
			{
				origin: environment.BETTER_AUTH_URL,
				secret: environment.BETTER_AUTH_SECRET,
				rpID: "localhost",
				allowSignUp: true,
			},
			database.db,
			{
				sendSignInCode: async (email, code) => {
					codes.set(email, code);
				},
				sendOrganizationInvitation: async () => {
					throw new Error("Unexpected runtime fixture invitation");
				},
			},
		);
		const email = `runtime-${randomUUID()}@example.invalid`;
		const session = await trustedCodeSignIn(
			auth,
			email,
			(email) => codes.get(email),
			new Headers({ origin: environment.BETTER_AUTH_URL }),
		);
		expect(session.status).toBe(200);
		const cookie = session.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		expect(cookie).not.toBe("");
		const anonymous = await fetch(`${origin}/settings?section=user`, {
			redirect: "manual",
		});
		expect(anonymous.status).toBeGreaterThanOrEqual(300);
		expect(anonymous.status).toBeLessThan(400);
		expect(anonymous.headers.get("location")).toContain("/login");
		await anonymous.arrayBuffer();
		async function privatePage() {
			const response = await fetch(`${origin}/settings?section=user`, {
				redirect: "manual",
				headers: { Cookie: `${cookie}; recount_locale=en` },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			const html = await response.text();
			expect(html).toContain(email);
			expect(html).toMatch(/<h1\b/);
			expect(html).not.toContain(environment.BETTER_AUTH_SECRET);
		}
		await privatePage();
		expect(await connections()).toBeGreaterThan(0);

		const address = new URL(origin);
		socket = createConnection({
			host: address.hostname,
			port: Number(address.port),
		});
		let closedAt: number | undefined;
		let receivedBytes = 0;
		let writeError: string | undefined;
		let writes = 0;
		let lastWriteAt = 0;
		socket.on("error", (error: NodeJS.ErrnoException) => {
			writeError = error.code ?? error.message;
		});
		socket.on("data", (data: Buffer) => {
			receivedBytes += data.length;
		});
		socket.once("close", () => {
			closedAt = performance.now();
		});
		await once(socket, "connect", { signal: AbortSignal.timeout(5_000) });
		socket.setNoDelay(true);
		const declaredBytes = 1024 * 1024;
		const prefix = `{"email":"${email}","otp":"`;
		socket.write(
			[
				"POST /api/auth/sign-in/email-otp HTTP/1.1",
				`Host: ${address.host}`,
				`Origin: ${environment.BETTER_AUTH_URL}`,
				`Cookie: ${cookie}`,
				"Content-Type: application/json",
				`Content-Length: ${declaredBytes}`,
				"Connection: close",
				"",
				prefix,
			].join("\r\n"),
		);
		// Never finish this body. Continued traffic distinguishes an active request from idle keep-alive.
		trickle = setInterval(() => {
			if (socket?.destroyed) return;
			socket?.write(" ", (error) => {
				if (error) writeError = error.message;
				else {
					writes++;
					lastWriteAt = performance.now();
				}
			});
		}, 100);
		await Bun.sleep(250);
		expect(writes, writeError).toBeGreaterThan(0);
		expect(receivedBytes).toBe(0);
		expect(closedAt).toBeUndefined();
		// Refresh real database activity immediately before stop, rather than relying on pool idle expiry.
		await privatePage();
		expect(await connections()).toBeGreaterThan(0);
		const writesBeforeStop = writes;
		const stoppingAt = performance.now();
		const stopping = Bun.spawn(["docker", "stop", "--time", "35", name], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "inherit",
			timeout: 45_000,
		});
		stopTask = stopping.exited;
		await Bun.sleep(12_000);
		expect(stopping.exitCode).toBeNull();
		expect(closedAt, writeError).toBeUndefined();
		expect(receivedBytes).toBe(0);
		expect(writes).toBeGreaterThan(writesBeforeStop + 2);
		expect(performance.now() - lastWriteAt).toBeLessThan(1_000);
		expect(await connections()).toBeGreaterThan(0);
		expect(await stopTask).toBe(0);
		const elapsed = performance.now() - stoppingAt;
		expect(elapsed).toBeGreaterThanOrEqual(14_000);
		// Finish after the 15s forced drain, before the application's 30s PG idle timeout can hide a leak.
		expect(elapsed).toBeLessThan(25_000);
		const closeDeadline = performance.now() + 5_000;
		while (closedAt === undefined && performance.now() < closeDeadline)
			await Bun.sleep(10);
		expect(closedAt).toBeDefined();
		expect((closedAt ?? 0) - stoppingAt).toBeGreaterThanOrEqual(14_000);
		expect(writes + Buffer.byteLength(prefix)).toBeLessThan(declaredBytes);
		expect(
			docker(["inspect", "--format", "{{.State.ExitCode}}", name])
				.stdout.toString()
				.trim(),
		).toBe("0");
		const databaseDeadline = performance.now() + 5_000;
		while ((await connections()) && performance.now() < databaseDeadline)
			await Bun.sleep(50);
		expect(await connections()).toBe(0);
	} finally {
		clearInterval(trickle);
		socket?.destroy();
		try {
			docker(["stop", "--time", "35", name]);
			docker(["rm", "--force", name]);
		} finally {
			try {
				await stopTask;
				await auth?.emailDelivery.close();
			} finally {
				await database.close();
			}
		}
	}
}, 120_000);
