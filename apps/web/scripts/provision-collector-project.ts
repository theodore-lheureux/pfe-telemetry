import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { createAuth } from "../src/auth/create-auth.server";
import { createEnrollmentKey } from "../src/collectors/collectors.server";
import { createDatabase } from "../src/db/client.server";
import { enrollmentKey } from "../src/db/schema";
import { listOrganizations } from "../src/organizations/organizations.server";
import {
	createProject,
	listProjects,
} from "../src/organizations/projects.server";

interface Input {
	email: string;
	organizationName: string;
	organizationSlug: string;
	projectName: string;
	stateDirectory: string;
	databaseUrl: string;
	origin: string;
	authSecret: string;
}

export async function provisionCollectorProject(input: Input) {
	const url = new URL(input.databaseUrl);
	if (
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		new URL(input.origin).protocol !== "https:" ||
		input.authSecret.length < 32 ||
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
	)
		throw new Error(
			"Explicit owner, HTTPS origin and loopback database required",
		);
	const directory = resolve(input.stateDirectory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const database = createDatabase({
		connectionString: input.databaseUrl,
		max: 4,
	});
	const auth = createAuth(
		{
			origin: input.origin,
			rpID: new URL(input.origin).hostname,
			secret: input.authSecret,
			allowSignUp: false,
		},
		database.db,
		{
			sendSignInCode: async () => {
				throw new Error(
					"Provisioning must not consume an owner's sign-in code",
				);
			},
			sendOrganizationInvitation: async () => {
				throw new Error("Provisioning does not send invitations");
			},
		},
	);
	const lock = await database.pool.connect();
	let changed = false;
	try {
		await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
			`collector-project:${input.organizationSlug}`,
		]);
		const context = await auth.$context;
		const existing = await context.internalAdapter.findUserByEmail(
			input.email.toLowerCase(),
		);
		const user =
			existing?.user ??
			(await context.internalAdapter.createUser(
				{
					email: input.email.toLowerCase(),
					name: "Owner",
					emailVerified: false,
				},
				{ method: "admin" },
			));
		changed = !existing;
		const actor = { id: user.id };
		let organization = (await listOrganizations(database.db, actor)).find(
			(entry) => entry.slug === input.organizationSlug,
		);
		if (!organization) {
			// Better Auth's server-only userId path creates canonical owner membership
			// without issuing a session or claiming the owner verified their email.
			const created = await auth.api.createOrganization({
				body: {
					userId: user.id,
					name: input.organizationName,
					slug: input.organizationSlug,
				},
			});
			organization = {
				id: created.id,
				name: created.name,
				slug: created.slug,
				logo: created.logo ?? null,
				role: "owner",
			};
			changed = true;
		}
		if (organization.role !== "owner")
			throw new Error("The designated account must own this organization");
		let project = (
			await listProjects(database.db, actor, organization.id)
		).find((entry) => entry.name === input.projectName);
		if (!project) {
			project = await createProject(database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: input.projectName,
			});
			changed = true;
		}
		const keyPath = resolve(directory, "enrollment.key");
		let saved: string | undefined;
		try {
			saved = (await readFile(keyPath, "utf8")).trim();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const [active] = await database.db
			.select({ digest: enrollmentKey.keySha256 })
			.from(enrollmentKey)
			.where(
				and(
					eq(enrollmentKey.projectId, project.id),
					eq(enrollmentKey.organizationId, organization.id),
					eq(enrollmentKey.name, "AWS collectors"),
					isNull(enrollmentKey.revokedAt),
				),
			);
		if (active) {
			if (
				!saved ||
				createHash("sha256").update(saved, "ascii").digest("hex") !==
					active.digest
			)
				throw new Error(
					"Restore the existing enrollment key; it was not reset",
				);
			await chmod(keyPath, 0o600);
		} else {
			if (saved) throw new Error("Saved enrollment key is no longer active");
			const created = await createEnrollmentKey(database.db, actor, {
				organizationId: organization.id,
				projectId: project.id,
				name: "AWS collectors",
				labels: ["aws"],
				maxNodes: 2,
			});
			await writeFile(keyPath, `${created.key}\n`, { flag: "wx", mode: 0o600 });
			changed = true;
		}
		return {
			changed,
			organizationId: organization.id,
			projectId: project.id,
			ownerId: user.id,
		};
	} finally {
		await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
			`collector-project:${input.organizationSlug}`,
		]);
		lock.release();
		await auth.emailDelivery.close();
		await database.pool.end();
	}
}

if (import.meta.main) {
	try {
		const input = JSON.parse(await Bun.stdin.text());
		const url = new URL(process.env.DATABASE_URL ?? "");
		url.hostname = "127.0.0.1";
		url.port = "15432";
		const result = await provisionCollectorProject({
			...input,
			databaseUrl: url.toString(),
			origin: process.env.BETTER_AUTH_URL ?? "",
			authSecret: process.env.BETTER_AUTH_SECRET ?? "",
		});
		console.log(JSON.stringify(result));
	} catch {
		console.error("Collector project provisioning failed; inspect privately");
		process.exitCode = 1;
	}
}
