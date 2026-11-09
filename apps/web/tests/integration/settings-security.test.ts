import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { twoFactor as nativeTwoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { accountContextHeader } from "../../src/auth/account-context";
import { actorService } from "../../src/auth/actor.server";
import { readAuthenticationState } from "../../src/auth/authentication-state.server";
import { createAuth } from "../../src/auth/create-auth.server";
import * as schema from "../../src/db/schema";
import { member, projectMember, twoFactor, user } from "../../src/db/schema";
import * as members from "../../src/organizations/members.server";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { trustedCodeSignIn } from "../auth-actors";
import { createTestDatabase } from "../database";
import { authenticatorCode } from "../totp";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let secret: string;
const codes = new Map<string, string>();
const origin = "http://localhost:3951";
function headersFrom(response: Response) {
	return new Headers({
		origin,
		cookie: response.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; "),
	});
}
async function actor() {
	const email = `${randomUUID()}@example.invalid`;
	const response = await trustedCodeSignIn(
		auth,
		email,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	const headers = headersFrom(response);
	const session = await auth.api.getSession({ headers });
	if (!session) throw new Error("Expected fixture account");
	headers.set(accountContextHeader, session.user.id);
	return { id: session.user.id, email, headers };
}

beforeAll(async () => {
	database = await createTestDatabase("settings");
	secret = `settings-${randomUUID()}-test-only-secret`;
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
});
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});

test("project customization persists isolated partial changes and serializes tags", async () => {
	const owner = await actor();
	const outsider = await actor();
	const org = await organizations.createOrganization(auth, owner.headers, {
		name: "Settings",
		slug: randomUUID(),
	});
	const project = await projects.createProject(database.db, owner, {
		requestId: randomUUID(),
		organizationId: org.id,
		name: "Project",
		slug: "settings",
	});
	const reference = { organizationId: org.id, projectId: project.id };
	expect(project).toMatchObject({
		tags: [],
		projectGroup: "",
		timeZone: "UTC",
		weekStartsOn: 0,
	});
	await Promise.all(
		["production", "Research"].map((tag) =>
			projects.updateProjectCustomization(database.db, owner, {
				...reference,
				action: "add-tag",
				tag,
			}),
		),
	);
	await projects.updateProjectCustomization(database.db, owner, {
		...reference,
		action: "add-tag",
		tag: "PRODUCTION",
	});
	await projects.updateProjectCustomization(database.db, owner, {
		...reference,
		action: "group",
		projectGroup: " Production apps ",
	});
	await projects.updateProjectCustomization(database.db, owner, {
		...reference,
		action: "time-zone",
		timeZone: "America/Toronto",
	});
	await projects.updateProjectCustomization(database.db, owner, {
		...reference,
		action: "week-start",
		weekStartsOn: 1,
	});
	const current = await projects.getProject(database.db, owner, reference);
	expect([...current.tags].sort()).toEqual(["Research", "production"]);
	expect(current).toMatchObject({
		projectGroup: "Production apps",
		timeZone: "America/Toronto",
		weekStartsOn: 1,
	});
	await expect(
		projects.updateProjectCustomization(database.db, outsider, {
			...reference,
			action: "group",
			projectGroup: "Wrong tenant",
		}),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		projects.updateProjectCustomization(database.db, owner, {
			...reference,
			action: "time-zone",
			timeZone: "Not/A_Time_Zone",
		}),
	).rejects.toMatchObject({ reason: "INVALID_PROJECT_SETTING" });
	await auth.api.addMember({
		body: { organizationId: org.id, userId: outsider.id, role: "member" },
	});
	const [membership] = await database.db
		.select()
		.from(member)
		.where(eq(member.userId, outsider.id));
	await database.db
		.insert(projectMember)
		.values({ ...reference, memberId: membership.id, role: "viewer" });
	await expect(
		projects.updateProjectCustomization(database.db, outsider, {
			...reference,
			action: "group",
			projectGroup: "Not allowed",
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const visible = await members.listOrganizationMembers(
		database.db,
		auth,
		outsider.headers,
		outsider,
		org.id,
	);
	const hidden = await projects.createProject(database.db, owner, {
		requestId: randomUUID(),
		organizationId: org.id,
		name: "Hidden project",
		slug: "hidden",
	});
	const scoped = await members.listOrganizationMembers(
		database.db,
		auth,
		outsider.headers,
		outsider,
		org.id,
	);
	expect(JSON.stringify(scoped)).not.toContain(hidden.id);
	expect(JSON.stringify(scoped)).not.toContain(hidden.name);
	expect(
		visible.every(
			(member) =>
				member.lastSignedInAt === null || member.userId === outsider.id,
		),
	).toBe(true);
});

test("email-code 2FA issues no usable session until TOTP or a single-use recovery code succeeds", async () => {
	const account = await actor();
	const enabled = await auth.api.enableTwoFactor({
		headers: account.headers,
		body: { method: "totp" },
	});
	if (!("totpURI" in enabled)) throw new Error("Expected authenticator setup");
	expect(
		(await auth.api.getSession({ headers: account.headers }))?.user
			.twoFactorEnabled,
	).toBe(false);
	const enrollment = await auth.api.verifyTOTP({
		headers: account.headers,
		body: { code: authenticatorCode(enabled.totpURI) },
		asResponse: true,
	});
	expect(enrollment.status).toBe(200);
	const enrolledHeaders = headersFrom(enrollment);
	expect(
		(await auth.api.getSession({ headers: enrolledHeaders }))?.user
			.twoFactorEnabled,
	).toBe(true);
	const [stored] = await database.db
		.select()
		.from(twoFactor)
		.where(eq(twoFactor.userId, account.id));
	expect(stored.verified).toBe(true);
	expect(stored.backupCodes).not.toContain(enabled.backupCodes[0]);
	await auth.api.signOut({ headers: enrolledHeaders });
	const [before] = await database.db
		.select()
		.from(user)
		.where(eq(user.id, account.id));
	const firstFactor = await trustedCodeSignIn(
		auth,
		account.email,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	expect(await firstFactor.json()).toMatchObject({ twoFactorRedirect: true });
	const challengeHeaders = headersFrom(firstFactor);
	expect(await auth.api.getSession({ headers: challengeHeaders })).toBeNull();
	expect(
		(await readAuthenticationState(challengeHeaders, auth)).twoFactorPending,
	).toBe(true);
	const denied = await actorService(auth)(challengeHeaders, (actor) =>
		organizations.listOrganizations(database.db, actor),
	);
	expect(denied.error?.code).toBe("UNAUTHENTICATED");
	const [during] = await database.db
		.select()
		.from(user)
		.where(eq(user.id, account.id));
	expect(during.lastSignedInAt).toEqual(before.lastSignedInAt);
	await expect(
		auth.api.verifyTOTP({
			headers: challengeHeaders,
			body: { code: "invalid" },
		}),
	).rejects.toBeDefined();
	await expect(
		auth.api.verifyTOTP({
			headers: challengeHeaders,
			body: { code: authenticatorCode(enabled.totpURI), trustDevice: true },
		}),
	).rejects.toMatchObject({ body: { code: "TRUST_DEVICE_DISABLED" } });
	const completed = await auth.api.verifyTOTP({
		headers: challengeHeaders,
		body: { code: authenticatorCode(enabled.totpURI), trustDevice: false },
		asResponse: true,
	});
	expect(completed.status).toBe(200);
	const completedHeaders = headersFrom(completed);
	expect(
		(await auth.api.getSession({ headers: completedHeaders }))?.user.id,
	).toBe(account.id);
	const other = await actor();
	const staleTab = new Headers(completedHeaders);
	staleTab.set(accountContextHeader, other.id);
	await expect(
		auth.api.disableTwoFactor({ headers: staleTab, body: {} }),
	).rejects.toMatchObject({ body: { code: "ACCOUNT_CHANGED" } });
	await expect(
		auth.api.generateBackupCodes({ headers: staleTab, body: {} }),
	).rejects.toMatchObject({ body: { code: "ACCOUNT_CHANGED" } });
	expect(
		(await auth.api.getSession({ headers: completedHeaders }))?.user
			.twoFactorEnabled,
	).toBe(true);
	await auth.api.signOut({ headers: completedHeaders });
	const recoveryStart = await trustedCodeSignIn(
		auth,
		account.email,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	const recovered = await auth.api.verifyBackupCode({
		headers: headersFrom(recoveryStart),
		body: { code: enabled.backupCodes[0], trustDevice: false },
		asResponse: true,
	});
	expect(recovered.status).toBe(200);
	await auth.api.signOut({ headers: headersFrom(recovered) });
	const replayStart = await trustedCodeSignIn(
		auth,
		account.email,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	await expect(
		auth.api.verifyBackupCode({
			headers: headersFrom(replayStart),
			body: { code: enabled.backupCodes[0] },
		}),
	).rejects.toBeDefined();
	const peer = betterAuth({
		appName: "Recount",
		baseURL: origin,
		secret,
		database: drizzleAdapter(database.db, {
			provider: "pg",
			schema,
			schemaName: "app",
			transaction: true,
		}),
		plugins: [nativeTwoFactor({ issuer: "Recount", allowPasswordless: true })],
	});
	const remembered = await peer.api.verifyTOTP({
		headers: headersFrom(replayStart),
		body: { code: authenticatorCode(enabled.totpURI), trustDevice: true },
		asResponse: true,
	});
	expect(remembered.status).toBe(200);
	const trustCookie = remembered.headers
		.getSetCookie()
		.filter((value) => value.split("=")[0].endsWith("trust_device"))
		.map((value) => value.split(";")[0])
		.join("; ");
	expect(trustCookie).not.toBe("");
	await auth.api.signOut({ headers: headersFrom(remembered) });
	const noBypass = await trustedCodeSignIn(
		auth,
		account.email,
		(email) => codes.get(email),
		new Headers({ origin, cookie: trustCookie }),
	);
	expect(await noBypass.json()).toMatchObject({ twoFactorRedirect: true });
	expect(
		await auth.api.getSession({ headers: headersFrom(noBypass) }),
	).toBeNull();
	const context = await auth.$context;
	const removeSession = context.internalAdapter.deleteSession;
	try {
		context.internalAdapter.deleteSession = async () => {
			throw new Error("Injected session deletion failure");
		};
		const failed = await trustedCodeSignIn(
			auth,
			account.email,
			(email) => codes.get(email),
			new Headers({ origin }),
		);
		expect(failed.status).toBe(500);
		expect(await failed.json()).toMatchObject({
			code: "TWO_FACTOR_UNAVAILABLE",
		});
		const sessionCookies = failed.headers
			.getSetCookie()
			.filter((value) => value.split("=")[0].endsWith("session_token"));
		expect(sessionCookies.length).toBeGreaterThan(0);
		expect(
			sessionCookies.every((value) => value.split(";")[0].split("=")[1] === ""),
		).toBe(true);
		expect(
			await auth.api.getSession({ headers: headersFrom(failed) }),
		).toBeNull();
	} finally {
		context.internalAdapter.deleteSession = removeSession;
	}
});
