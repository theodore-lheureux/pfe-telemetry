import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { actorService } from "../src/auth/actor.server";
import { createAuth } from "../src/auth/create-auth.server";
import * as collectorDomain from "../src/collectors/collectors.server";
import { createDatabase } from "../src/db/client.server";
import { enrollmentKey } from "../src/db/schema";
import type { OperationResult } from "../src/lib/operation-result";
import * as organizationDomain from "../src/organizations/organizations.server";
import * as projectDomain from "../src/organizations/projects.server";

interface Node {
	name: string;
	hostId: string;
}

interface Input {
	email: string;
	organizationName: string;
	organizationSlug: string;
	projectName: string;
	stateDirectory: string;
	nodes: Node[];
	databaseUrl: string;
	origin: string;
	authSecret: string;
}

function data<T>(result: OperationResult<T>): T {
	if (result.error)
		throw new Error(
			"Demo operation was denied; no existing account or enrollment key was reset.",
		);
	return result.data;
}

async function exists(path: string) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function provisionDemoCollectors(input: Input) {
	const origin = new URL(input.origin);
	const databaseUrl = new URL(input.databaseUrl);
	if (
		origin.protocol !== "http:" ||
		origin.hostname !== "localhost" ||
		origin.origin !== input.origin ||
		!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
		input.authSecret.length < 32 ||
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
		input.nodes.length === 0 ||
		input.nodes.length > 2 ||
		new Set(input.nodes.map((node) => node.name)).size !== input.nodes.length ||
		new Set(input.nodes.map((node) => node.hostId)).size !==
			input.nodes.length ||
		input.nodes.some(
			(node) =>
				!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(node.name) ||
				!node.hostId ||
				node.hostId.length > 128,
		)
	)
		throw new Error(
			"Demo enrollment requires a loopback app/database, an owner email, and one or two exact VM host IDs.",
		);
	const directory = resolve(input.stateDirectory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const database = createDatabase({
		connectionString: input.databaseUrl,
		max: 4,
	});
	const lock = await database.pool.connect();
	let headers: Headers | undefined;
	let changed = false;
	let signInCode: string | undefined;
	const auth = createAuth(
		{
			origin: input.origin,
			rpID: "localhost",
			secret: input.authSecret,
			allowSignUp: true,
		},
		database.db,
		{
			// This trusted local bootstrap consumes its own native email code in memory.
			sendSignInCode: async (recipient, code) => {
				if (recipient !== input.email)
					throw new Error("Unexpected demo account.");
				signInCode = code;
			},
			sendOrganizationInvitation: async () => {
				throw new Error("Demo enrollment does not send invitations.");
			},
		},
	);
	try {
		await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
			`local-vm-demo:${input.email}:${input.organizationSlug}`,
		]);
		await auth.api.sendVerificationOTP({
			body: { email: input.email, type: "sign-in" },
		});
		await auth.emailDelivery.drain();
		if (!signInCode)
			throw new Error("Could not provision the native demo account.");
		const verified = await auth.api.signInEmailOTP({
			body: { email: input.email, otp: signInCode },
			headers: { origin: input.origin },
			asResponse: true,
		});
		const cookies = verified.headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0]);
		if (cookies.length === 0)
			throw new Error("Demo account verification did not issue a session.");
		const verifiedHeaders = new Headers({
			origin: input.origin,
			cookie: cookies.join("; "),
		});
		headers = verifiedHeaders;
		const organizations = actorService(auth);
		let organization = data(
			await organizations(headers, (actor) =>
				organizationDomain.listOrganizations(database.db, actor),
			),
		).find((item) => item.slug === input.organizationSlug);
		if (!organization) {
			organization = data(
				await organizations(verifiedHeaders, () =>
					organizationDomain.createOrganization(auth, verifiedHeaders, {
						name: input.organizationName,
						slug: input.organizationSlug,
					}),
				),
			);
			changed = true;
		}
		if (organization.role !== "owner")
			throw new Error("The requested account must own the demo organization.");
		let project = data(
			await organizations(headers, (actor) =>
				projectDomain.listProjects(database.db, actor, organization.id),
			),
		).find((item) => item.name === input.projectName);
		if (!project) {
			project = data(
				await organizations(headers, (actor) =>
					projectDomain.createProject(database.db, actor, {
						requestId: crypto.randomUUID(),
						organizationId: organization.id,
						name: input.projectName,
					}),
				),
			);
			changed = true;
		}
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		// One enrollment key for every demo VM; each VM enrolls itself with its host ID.
		const keyName = "Demo VMs";
		const keyPath = resolve(directory, "enrollment.key");
		const saved = (await exists(keyPath))?.trim();
		if (saved !== undefined) {
			const [active] = await database.db
				.select({ id: enrollmentKey.id })
				.from(enrollmentKey)
				.where(
					and(
						eq(enrollmentKey.projectId, project.id),
						eq(enrollmentKey.organizationId, organization.id),
						eq(
							enrollmentKey.keySha256,
							createHash("sha256").update(saved, "ascii").digest("hex"),
						),
						isNull(enrollmentKey.revokedAt),
					),
				);
			if (!active)
				throw new Error(
					"The saved demo enrollment key is revoked or belongs to another project. Restore the correct key or remove the file to create a new one.",
				);
			await chmod(keyPath, 0o600);
		} else {
			const [existing] = await database.db
				.select({ id: enrollmentKey.id })
				.from(enrollmentKey)
				.where(
					and(
						eq(enrollmentKey.projectId, project.id),
						eq(enrollmentKey.name, keyName),
						isNull(enrollmentKey.revokedAt),
					),
				);
			if (existing)
				throw new Error(
					"The demo enrollment key file is missing. Restore its once-revealed key or revoke the key before creating a new one.",
				);
			const created = data(
				await actorService(auth)(headers, (actor) =>
					collectorDomain.createEnrollmentKey(database.db, actor, {
						...reference,
						name: keyName,
						labels: ["demo"],
					}),
				),
			);
			await writeFile(keyPath, `${created.key}\n`, { flag: "wx", mode: 0o600 });
			changed = true;
		}
		const nodes = input.nodes.map((node) => ({
			name: node.name,
			hostId: node.hostId,
		}));
		const result = {
			changed,
			email: input.email,
			...reference,
			organizationSlug: input.organizationSlug,
			nodes,
		};
		await writeFile(
			resolve(directory, "enrollment.json"),
			`${JSON.stringify(result, null, 2)}\n`,
			{ mode: 0o600 },
		);
		return result;
	} finally {
		if (headers)
			await auth
				.handler(
					new Request(`${input.origin}/api/auth/sign-out`, {
						method: "POST",
						headers,
					}),
				)
				.catch(() => {});
		await lock
			.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
				`local-vm-demo:${input.email}:${input.organizationSlug}`,
			])
			.catch(() => {});
		lock.release();
		await auth.emailDelivery.close();
		await database.pool.end();
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			email: { type: "string" },
			nodes: { type: "string" },
			"state-directory": { type: "string" },
			"organization-name": { type: "string", default: "Recount demo" },
			"organization-slug": { type: "string", default: "recount-demo" },
			"project-name": { type: "string", default: "Local VMs" },
		},
	});
	try {
		const result = await provisionDemoCollectors({
			email: values.email ?? "",
			nodes: JSON.parse(values.nodes ?? "[]"),
			stateDirectory: values["state-directory"] ?? "infra/telemetry/.state",
			organizationName: values["organization-name"],
			organizationSlug: values["organization-slug"],
			projectName: values["project-name"],
			databaseUrl: process.env.DATABASE_URL ?? "",
			origin: process.env.BETTER_AUTH_URL ?? "",
			authSecret: process.env.BETTER_AUTH_SECRET ?? "",
		});
		console.log(JSON.stringify(result));
	} catch {
		console.error(
			"Local demo enrollment failed. Check the loopback app environment, owner access and saved enrollment key file; existing keys were not reset.",
		);
		process.exitCode = 1;
	}
}
