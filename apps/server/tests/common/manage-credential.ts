import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const web =
	process.env.PFE_TEST_WEB_DIRECTORY ??
	resolve(import.meta.dir, "../../../web");
const { createAuth } = await import(`${web}/src/auth/create-auth.server.ts`);
const { createDatabase } = await import(`${web}/src/db/client.server.ts`);
const { createOrganizationRequests } = await import(
	`${web}/src/organizations/request.server.ts`
);
const { createCollectorCredentialRequests } = await import(
	`${web}/src/credentials/credentials.server.ts`
);
const connectionString = process.env.DATABASE_URL;
assert(connectionString);
const database = createDatabase({ connectionString, max: 1 });
const origin = "http://localhost:3001";
let signInLink: string | undefined;
const auth = createAuth(
	{
		origin,
		rpID: "localhost",
		secret: `test-only-${randomUUID()}`,
		allowSignUp: true,
	},
	database.db,
	{
		sendSignInLink: async (_email: string, link: string) => {
			signInLink = link;
		},
		sendOrganizationInvitation: async () => {},
	},
);
const requested = await auth.handler(
	new Request(`${origin}/api/auth/sign-in/magic-link`, {
		method: "POST",
		headers: {
			origin,
			"content-type": "application/json",
			"x-forwarded-for": "192.0.2.1",
		},
		body: JSON.stringify({
			email: "collector-admin@example.invalid",
			callbackURL: "/account",
		}),
	}),
);
assert.equal(requested.status, 200);
assert(signInLink);
const signedIn = await auth.handler(new Request(signInLink));
const headers = new Headers({
	origin,
	cookie: signedIn.headers
		.getSetCookie()
		.map((value: string) => value.split(";")[0])
		.join("; "),
});
function data<T>(result: { data: T; error: { message: string } | null }): T {
	assert.equal(result.error, null);
	return result.data;
}
const organizations = createOrganizationRequests(database.db, auth);
const organization = data<{ id: string }>(
	await organizations.createOrganization(headers, {
		name: "Live collectors",
		slug: "live-collectors",
	}),
);
const project = data<{ id: string }>(
	await organizations.createProject(headers, {
		organizationId: organization.id,
		name: "Live ingestion",
		slug: "live-ingestion",
	}),
);
const reference = { organizationId: organization.id, projectId: project.id };
const credentials = createCollectorCredentialRequests(database.db, auth);
const created = data<{ token: string; credential: { id: string } }>(
	await credentials.createCollectorCredential(headers, {
		...reference,
		name: "Live test",
		sourceId: "web-managed-source",
		hosts: ["node1"],
	}),
);
// Stdout is a private parent-process pipe, never a test log or a token file.
process.stdout.write(
	`${JSON.stringify({ token: created.token, projectId: project.id })}\n`,
);
try {
	for await (const command of createInterface({ input: process.stdin })) {
		const scope = { ...reference, credentialId: created.credential.id };
		if (command === "rotate") {
			const rotated = data<{ token: string }>(
				await credentials.rotateCollectorCredential(headers, scope),
			);
			process.stdout.write(`${JSON.stringify({ token: rotated.token })}\n`);
		} else if (command === "revoke") {
			data(await credentials.revokeCollectorCredential(headers, scope));
			process.stdout.write("{}\n");
		} else {
			assert.equal(command, "stop");
			break;
		}
	}
} finally {
	await database.pool.end();
	process.stdin.destroy();
}
