import type { createAuth } from "../src/auth/create-auth.server";

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
