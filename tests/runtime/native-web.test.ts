import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromCrossJSON, toJSONAsync } from "seroval";
import { actorService } from "../../apps/web/src/auth/actor.server";
import { createAuth } from "../../apps/web/src/auth/create-auth.server";
import * as credentials from "../../apps/web/src/credentials/credentials.server";
import type { ExecutionSummary } from "../../apps/web/src/executions/contracts";
import * as executions from "../../apps/web/src/executions/executions.server";
import type { OperationResult } from "../../apps/web/src/organizations/contracts";
import * as organizations from "../../apps/web/src/organizations/organizations.server";
import * as projects from "../../apps/web/src/organizations/projects.server";
import { trustedCodeSignIn } from "../../apps/web/tests/auth-actors";
import { createTestDatabase } from "../../apps/web/tests/database";
import { stageWeb } from "../ci/stage-artifacts";

function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}
async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
	const deadline = performance.now() + timeout;
	while (!(await check())) {
		if (performance.now() >= deadline)
			throw new Error("Runtime assertion did not settle");
		await Bun.sleep(10);
	}
}

test("generated Bun output serves localized public pages and safe static assets without backend access", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "recount-nitro-"));
	const artifact = join(temporary, "web");
	await stageWeb(artifact);
	const reservation = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = reservation.port;
	if (!port) throw new Error("Expected a reserved port");
	await reservation.stop(true);
	const origin = `http://localhost:${port}`;
	const request = (path: string, options: RequestInit = {}) =>
		fetch(`${origin}${path}`, {
			...options,
			headers: { ...options.headers, Connection: "close" },
		});
	const secret = randomUUID().repeat(2);
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "server/index.mjs"],
		{
			cwd: artifact,
			env: {
				PATH: process.env.PATH,
				NODE_ENV: "production",
				NITRO_HOST: "127.0.0.1",
				NITRO_PORT: String(port),
				DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
				BETTER_AUTH_URL: origin,
				BETTER_AUTH_SECRET: secret,
				SMTP_HOST: "127.0.0.1",
				SMTP_PORT: "31562",
				RECOUNT_AUTH_ALLOW_SIGN_UP: "true",
				SMTP_USER: "test-only",
				SMTP_PASSWORD: "test-only",
				EMAIL_FROM: "tests@example.invalid",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const output = new Response(child.stdout).text();
	const errors = new Response(child.stderr).text();
	let socket: Socket | undefined;
	let trickle: ReturnType<typeof setInterval> | undefined;
	try {
		await until(async () => {
			if (child.exitCode !== null) throw new Error(await errors);
			try {
				const response = await request("/login", {
					signal: AbortSignal.timeout(1_000),
				});
				await response.arrayBuffer();
				return response.status === 200;
			} catch {
				return false;
			}
		}, 20_000);
		let html = "";
		for (const locale of ["en", "fr"]) {
			const response = await request("/login", {
				headers: { Cookie: `recount_locale=${locale}` },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			html = await response.text();
			expect(html).toMatch(new RegExp(`<html\\b[^>]*\\blang="${locale}"`));
			expect(html).not.toContain(secret);
		}
		const asset = html.match(/(?:src|href)="(\/assets\/[^"?]+\.js)"/)?.[1];
		if (!asset) throw new Error("Expected a generated JavaScript asset");
		const get = await request(asset);
		const body = await get.arrayBuffer();
		expect(get.status).toBe(200);
		expect(get.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
		expect(get.headers.get("x-content-type-options")).toBe("nosniff");
		const head = await request(asset, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(Number(head.headers.get("content-length"))).toBe(body.byteLength);
		expect(await head.text()).toBe("");
		for (const path of [
			"/.env",
			"/server/index.mjs",
			"/.output/server/index.mjs",
			"/src/server.ts",
			`${asset}.map`,
			"/%2e%2e%2fserver/index.mjs",
		]) {
			const response = await request(path);
			expect(response.status, path).toBe(404);
			await response.arrayBuffer();
		}
		const malformed = await request("/%GG");
		expect(malformed.status).toBe(400);
		await malformed.arrayBuffer();
		const icon = await request("/brand/recount-app-icon.svg");
		expect(icon.status).toBe(200);
		expect(icon.headers.get("cache-control")).toBeNull();
		expect(icon.headers.get("etag")).toBeTruthy();
		await icon.arrayBuffer();
		socket = createConnection({ host: "127.0.0.1", port });
		await once(socket, "connect", { signal: AbortSignal.timeout(5_000) });
		let closedAt: number | undefined;
		let receivedBytes = 0;
		let received = "";
		let writes = 0;
		let lastWriteAt = 0;
		socket.on("error", () => {});
		socket.on("data", (data) => {
			receivedBytes += data.length;
			received += data.toString();
		});
		socket.once("close", () => {
			closedAt = performance.now();
		});
		socket.setNoDelay(true);
		const manifest = readFileSync(
			new URL("../../apps/web/.output/server/_ssr/ssr.mjs", import.meta.url),
			"utf8",
		);
		const slowRpc = manifest.match(
			/"([a-f0-9]+)": \{\s*functionName: "createExecution_createServerFn_handler"/,
		)?.[1];
		if (!slowRpc) throw new Error("Expected compiled createExecution RPC");
		socket.write(
			[
				`POST /_serverFn/${slowRpc} HTTP/1.1`,
				`Host: localhost:${port}`,
				`Origin: ${origin}`,
				"Content-Type: application/json",
				"x-tsr-serverFn: true",
				"Content-Length: 1048576",
				"Connection: close",
				"",
				'{"data":"',
			].join("\r\n"),
		);
		trickle = setInterval(() => {
			if (!socket?.destroyed)
				socket?.write(" ", (error) => {
					if (!error) {
						writes++;
						lastWriteAt = performance.now();
					}
				});
		}, 100);
		await Bun.sleep(250);
		expect(writes, received).toBeGreaterThan(0);
		expect(receivedBytes).toBe(0);
		expect(closedAt).toBeUndefined();
		const beforeStop = writes;
		const stopped = performance.now();
		child.kill("SIGTERM");
		await Bun.sleep(12_000);
		expect(child.exitCode).toBeNull();
		expect(closedAt).toBeUndefined();
		expect(receivedBytes).toBe(0);
		expect(writes).toBeGreaterThan(beforeStop + 2);
		expect(performance.now() - lastWriteAt).toBeLessThan(1_000);
		await until(() => child.exitCode !== null, 13_000);
		expect(performance.now() - stopped).toBeGreaterThanOrEqual(14_000);
		expect(performance.now() - stopped).toBeLessThan(25_000);
		await until(() => closedAt !== undefined);
		expect((closedAt ?? 0) - stopped).toBeGreaterThanOrEqual(14_000);
		expect(await child.exited, await errors).toBe(0);
		expect(await output).not.toContain(secret);
	} finally {
		clearInterval(trickle);
		socket?.destroy();
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await rm(temporary, { recursive: true });
	}
}, 30_000);

test("generated Bun output preserves private localized SSR, static assets, Date RPC and same-resource bounded cleanup", async () => {
	const database = await createTestDatabase("nitro");
	const applicationName = `recount-nitro-${randomUUID()}`;
	const databaseUrl = new URL(database.url);
	databaseUrl.searchParams.set("application_name", applicationName);
	const reservation = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = reservation.port;
	if (!port) throw new Error("Expected a reserved port");
	await reservation.stop(true);
	const origin = `http://localhost:${port}`;
	const secret = randomUUID().repeat(2);
	const codes = new Map<string, string>();
	const auth = createAuth(
		{ origin, secret, rpID: "localhost", allowSignUp: true },
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	const telemetrySockets = new Set<Socket>();
	let telemetryQueries = 0;
	const telemetry = createServer((request, response) => {
		request.resume();
		telemetryQueries++;
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end("");
	});
	telemetry.keepAliveTimeout = 60_000;
	telemetry.on("connection", (socket) => {
		telemetrySockets.add(socket);
		socket.once("close", () => telemetrySockets.delete(socket));
	});
	telemetry.listen(0, "127.0.0.1");
	await once(telemetry, "listening");
	const telemetryAddress = telemetry.address();
	if (!telemetryAddress || typeof telemetryAddress === "string")
		throw new Error("Expected test telemetry port");
	const messages: Array<{
		type: string;
		totalCount?: number;
		closing?: boolean;
		poolEnded?: boolean;
	}> = [];
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"--preload",
			new URL("./observe-web.ts", import.meta.url).pathname,
			".output/server/index.mjs",
		],
		{
			cwd: new URL("../../apps/web/", import.meta.url).pathname,
			env: {
				PATH: process.env.PATH,
				NODE_ENV: "production",
				NITRO_HOST: "127.0.0.1",
				NITRO_PORT: String(port),
				DATABASE_URL: databaseUrl.toString(),
				BETTER_AUTH_URL: origin,
				BETTER_AUTH_SECRET: secret,
				RECOUNT_AUTH_ALLOW_SIGN_UP: "true",
				SMTP_HOST: "127.0.0.1",
				SMTP_PORT: "31562",
				SMTP_USER: "test-only",
				SMTP_PASSWORD: "test-only",
				EMAIL_FROM: "tests@example.invalid",
				RECOUNT_CLICKHOUSE_URL: `http://127.0.0.1:${telemetryAddress.port}`,
				RECOUNT_CLICKHOUSE_READER_PASSWORD: "test-only",
			},
			stdout: "pipe",
			stderr: "pipe",
			ipc: (message) => messages.push(message),
		},
	);
	const output = new Response(child.stdout).text();
	const errors = new Response(child.stderr).text();
	let socket: Socket | undefined;
	let trickle: ReturnType<typeof setInterval> | undefined;
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
		await until(async () => {
			if (child.exitCode !== null) throw new Error(await errors);
			try {
				const response = await fetch(`${origin}/login`, {
					signal: AbortSignal.timeout(1_000),
				});
				await response.arrayBuffer();
				return response.status === 200;
			} catch {
				return false;
			}
		}, 20_000);
		let html = "";
		for (const locale of ["en", "fr"]) {
			const response = await fetch(`${origin}/login`, {
				headers: { Cookie: `recount_locale=${locale}` },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			html = await response.text();
			expect(html).toMatch(new RegExp(`<html\\b[^>]*\\blang="${locale}"`));
			expect(html).not.toContain(secret);
			expect(html).not.toContain(databaseUrl.toString());
		}
		const asset = html.match(/(?:src|href)="(\/assets\/[^"?]+\.js)"/)?.[1];
		expect(asset).toBeDefined();
		const get = await fetch(`${origin}${asset}`);
		const bytes = await get.arrayBuffer();
		expect(get.status).toBe(200);
		expect(get.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
		expect(get.headers.get("x-content-type-options")).toBe("nosniff");
		const head = await fetch(`${origin}${asset}`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(Number(head.headers.get("content-length"))).toBe(bytes.byteLength);
		expect(head.headers.get("content-type")).toBe(
			get.headers.get("content-type"),
		);
		expect(await head.text()).toBe("");
		for (const path of [
			"/.env",
			"/server/index.mjs",
			"/.output/server/index.mjs",
			"/src/server.ts",
			"/packages/transactional/src/index.tsx",
			`${asset}.map`,
			"/%2e%2e%2fserver/index.mjs",
		]) {
			const response = await fetch(`${origin}${path}`);
			expect(response.status, path).toBe(404);
			await response.arrayBuffer();
		}
		const malformed = await fetch(`${origin}/%GG`);
		expect(malformed.status).toBe(400);
		await malformed.arrayBuffer();
		const email = `native-${randomUUID()}@example.invalid`;
		const session = await trustedCodeSignIn(
			auth,
			email,
			(email) => codes.get(email),
			new Headers({ origin }),
		);
		expect(session.status).toBe(200);
		const cookie = session.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const headers = new Headers({ origin, cookie });
		const operations = actorService(auth);
		const organization = data(
			await operations(headers, () =>
				organizations.createOrganization(auth, headers, {
					name: "Native hosting",
					slug: "native-hosting",
				}),
			),
		);
		const project = data(
			await operations(headers, (actor) =>
				projects.createProject(database.db, actor, {
					requestId: randomUUID(),
					organizationId: organization.id,
					name: "Private",
					slug: "private",
				}),
			),
		);
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		const credential = data(
			await operations(headers, (actor) =>
				credentials.createCollectorCredential(database.db, actor, {
					...reference,
					name: "Source",
					sourceId: "native-source",
					rootId: "node1",
					rootKind: 1,
					adapter: "linux",
					allowedLocalKinds: [4],
				}),
			),
		);
		const execution = data(
			await operations(headers, (actor) =>
				executions.createExecution(database.db, actor, {
					...reference,
					requestId: randomUUID(),
					name: "Native execution",
					credentialId: credential.credential.id,
					hostId: null,
					startedAt: "2026-11-03T10:00:00Z",
					endedAt: "2026-11-03T11:00:00Z",
				}),
			),
		);
		const manifest = readFileSync(
			new URL("../../apps/web/.output/server/_ssr/ssr.mjs", import.meta.url),
			"utf8",
		);
		async function rpc<T>(operation: string, input: unknown): Promise<T> {
			const id = manifest.match(
				new RegExp(
					`"([a-f0-9]+)": \\{\\s*functionName: "${operation}_createServerFn_handler"`,
				),
			)?.[1];
			if (!id) throw new Error(`Missing compiled RPC ${operation}`);
			const url = new URL(`/_serverFn/${id}`, origin);
			url.searchParams.set(
				"payload",
				JSON.stringify(await toJSONAsync({ data: input })),
			);
			const response = await fetch(url, {
				headers: { ...Object.fromEntries(headers), "x-tsr-serverFn": "true" },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain(
				"application/json",
			);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			const result = fromCrossJSON<{
				result: OperationResult<T>;
				error?: unknown;
			}>(await response.json(), { refs: new Map() });
			if (result.error) throw result.error;
			return data(result.result);
		}
		const result = await rpc<ExecutionSummary>("getExecution", {
			...reference,
			executionId: execution.executionId,
		});
		expect(result.startedAt).toBeInstanceOf(Date);
		expect(result.startedAt.toISOString()).toBe("2026-11-03T10:00:00.000Z");
		await rpc("queryExecutionTelemetry", {
			...reference,
			executionId: execution.executionId,
			buckets: 10,
		});
		expect(telemetryQueries).toBe(1);
		expect(telemetrySockets.size).toBeGreaterThan(0);
		expect(
			messages.some((message) => message.type === "telemetry-closed"),
		).toBe(false);
		const anonymous = await fetch(`${origin}/settings?section=user`, {
			redirect: "manual",
		});
		expect(anonymous.status).toBeGreaterThanOrEqual(300);
		expect(anonymous.status).toBeLessThan(400);
		expect(anonymous.headers.get("location")).toContain("/login");
		await anonymous.arrayBuffer();
		async function privatePage(locale = "en") {
			const localizedHeaders = new Headers(headers);
			localizedHeaders.set("cookie", `${cookie}; recount_locale=${locale}`);
			const response = await fetch(`${origin}/settings?section=user`, {
				headers: localizedHeaders,
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			const html = await response.text();
			expect(html).toContain(email);
			expect(html).toMatch(new RegExp(`<html\\b[^>]*\\blang="${locale}"`));
			expect(html).not.toContain(secret);
		}
		await privatePage();
		await privatePage("fr");
		expect(await connections()).toBeGreaterThan(0);
		child.send({ type: "hold-email" });
		await until(() =>
			messages.some((message) => message.type === "holding-email"),
		);
		socket = createConnection({ host: "127.0.0.1", port });
		await once(socket, "connect", { signal: AbortSignal.timeout(5_000) });
		let closedAt: number | undefined;
		let receivedBytes = 0;
		let writes = 0;
		let lastWriteAt = 0;
		socket.on("error", () => {});
		socket.on("data", (data) => {
			receivedBytes += data.length;
		});
		socket.once("close", () => {
			closedAt = performance.now();
		});
		socket.setNoDelay(true);
		const prefix = `{"email":"${email}","otp":"`;
		socket.write(
			[
				"POST /api/auth/sign-in/email-otp HTTP/1.1",
				`Host: localhost:${port}`,
				`Origin: ${origin}`,
				`Cookie: ${cookie}`,
				"Content-Type: application/json",
				"Content-Length: 1048576",
				"Connection: close",
				"",
				prefix,
			].join("\r\n"),
		);
		trickle = setInterval(() => {
			if (!socket?.destroyed)
				socket?.write(" ", (error) => {
					if (!error) {
						writes++;
						lastWriteAt = performance.now();
					}
				});
		}, 100);
		await Bun.sleep(250);
		expect(writes).toBeGreaterThan(0);
		expect(receivedBytes).toBe(0);
		expect(closedAt).toBeUndefined();
		await privatePage();
		expect(await connections()).toBeGreaterThan(0);
		const writesBeforeStop = writes;
		const stoppingAt = performance.now();
		child.kill("SIGTERM");
		await Bun.sleep(12_000);
		expect(child.exitCode).toBeNull();
		expect(closedAt).toBeUndefined();
		expect(receivedBytes).toBe(0);
		expect(writes).toBeGreaterThan(writesBeforeStop + 2);
		expect(performance.now() - lastWriteAt).toBeLessThan(1_000);
		expect(await connections()).toBeGreaterThan(0);
		await until(() => closedAt !== undefined);
		expect((closedAt ?? 0) - stoppingAt).toBeGreaterThanOrEqual(14_000);
		expect(performance.now() - stoppingAt).toBeLessThan(25_000);
		expect(writes + Buffer.byteLength(prefix)).toBeLessThan(1048576);
		// Owned email work keeps cleanup pending after the HTTP drain; release it explicitly.
		expect(await connections()).toBeGreaterThan(0);
		child.send({ type: "release-email" });
		await until(() => messages.some((message) => message.type === "closed"));
		expect(
			messages.find((message) => message.type === "email-closing"),
		).toMatchObject({ closing: true, poolEnded: false });
		expect(
			messages.find((message) => message.type === "closed")?.totalCount,
		).toBe(0);
		expect(
			messages.filter((message) => message.type === "telemetry-closed"),
		).toHaveLength(1);
		await until(
			async () => (await connections()) === 0 && telemetrySockets.size === 0,
		);
		expect(child.exitCode).toBeNull();
		child.send({ type: "finish" });
		expect(await child.exited, await errors).toBe(0);
		expect(await output).not.toContain(secret);
	} finally {
		clearInterval(trickle);
		socket?.destroy();
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		for (const socket of telemetrySockets) socket.destroy();
		await new Promise<void>((resolve) => telemetry.close(() => resolve()));
		await auth.emailDelivery.close();
		await database.close();
	}
}, 120_000);
