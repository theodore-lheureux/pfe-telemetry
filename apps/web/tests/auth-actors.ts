import type { createAuth } from "../src/auth/create-auth.server";

export function responseCookie(response: Response) {
	return response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
}

export function sessionHeaders(response: Response, headers = new Headers()) {
	const result = new Headers(headers);
	result.set("cookie", responseCookie(response));
	return result;
}

export async function trustedActor(
	auth: ReturnType<typeof createAuth>,
	email: string,
	readCode: (email: string) => string | undefined,
	headers = new Headers(),
) {
	const response = await trustedCodeSignIn(auth, email, readCode, headers);
	const signedIn = sessionHeaders(response, headers);
	const session = await auth.api.getSession({ headers: signedIn });
	if (!session?.user.id) throw new Error("Expected fixture session");
	return { id: session.user.id, email, headers: signedIn };
}

export async function trustedCodeSignIn(
	auth: ReturnType<typeof createAuth>,
	email: string,
	readCode: (email: string) => string | undefined,
	headers = new Headers(),
) {
	await auth.api.sendVerificationOTP({
		body: { email, type: "sign-in" },
		headers,
	});
	await auth.emailDelivery.drain();
	const otp = readCode(email.toLowerCase());
	if (!otp) throw new Error("Expected an in-memory fixture code");
	return auth.api.signInEmailOTP({
		body: { email, otp },
		headers,
		asResponse: true,
	});
}
