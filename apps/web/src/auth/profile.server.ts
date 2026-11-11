import { parseName } from "../lib/input";
import { OperationError } from "../lib/operation-error";
import type { createAuth } from "./create-auth.server";
import { applicationSession } from "./session.server";
import { sessionDevice, sessionLocation } from "./session-details.server";

type Auth = ReturnType<typeof createAuth>;

export async function updateProfileName(
	auth: Auth,
	headers: Headers,
	name: string,
	userId: string,
) {
	const current = await applicationSession(auth, headers);
	if (current.user.id !== userId)
		throw new OperationError("FORBIDDEN", "Account changed");
	const validName = parseName(name);
	await auth.api.updateUser({ headers, body: { name: validName } });
	return { name: validName };
}

export async function listWebSessions(
	database: ReturnType<typeof getDatabase>,
	auth: Auth,
	headers: Headers,
) {
	const current = await applicationSession(auth, headers);
	const sessions = await database
		.select({
			id: session.id,
			userId: session.userId,
			userAgent: session.userAgent,
			ipAddress: session.ipAddress,
			signInMethod: session.signInMethod,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		})
		.from(session)
		.where(
			and(
				eq(session.userId, current.user.id),
				gt(session.expiresAt, new Date()),
			),
		);
	return sessions
		.filter((session) => session.userId === current.user.id)
		.map((session) => ({
			id: session.id,
			userId: session.userId,
			device: sessionDevice(session.userAgent),
			location: sessionLocation(session.ipAddress),
			signInMethod:
				session.signInMethod === "passkey" ||
				session.signInMethod === "email-otp"
					? session.signInMethod
					: null,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			current: session.id === current.session.id,
		}));
}

export async function revokeWebSession(
	auth: Auth,
	headers: Headers,
	id: string,
) {
	const current = await applicationSession(auth, headers);
	const sessions = await auth.api.listSessions({ headers });
	const target = sessions.find(
		(session) => session.id === id && session.userId === current.user.id,
	);
	if (!target) throw new OperationError("NOT_FOUND", "Session not found");
	if (target.id === current.session.id)
		throw new OperationError(
			"FORBIDDEN",
			"Use sign out for the current session",
		);
	await auth.api.revokeSession({ headers, body: { token: target.token } });
	return { id };
}

import { and, eq, gt } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { session } from "../db/schema";
