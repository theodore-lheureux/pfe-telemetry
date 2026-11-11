import type { AuthenticationResponseJSON } from "@better-auth/passkey/client";
import {
	startAuthentication,
	startRegistration,
	WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { accountContextHeader } from "./account-context";
import { authClient } from "./client";

export async function registerPasskey(
	signal: AbortSignal,
	userId: string,
	name?: string,
) {
	if (
		!window.isSecureContext ||
		typeof PublicKeyCredential !== "function" ||
		typeof navigator.credentials?.create !== "function"
	)
		throw new Error("Passkey registration is unavailable");
	const options = await authClient.passkey.generateRegisterOptions({
		fetchOptions: { signal },
	});
	if (signal.aborted) throw new Error("Registration retired");
	if (options.error) return options;
	const cancel = () => WebAuthnAbortService.cancelCeremony();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		const response = await startRegistration({ optionsJSON: options.data });
		if (signal.aborted) throw new Error("Registration retired");
		return await authClient.passkey.verifyRegistration({
			response,
			name,
			fetchOptions: { signal, headers: { [accountContextHeader]: userId } },
		});
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

export function passkeyAuthenticationSupported() {
	return (
		window.isSecureContext &&
		typeof PublicKeyCredential === "function" &&
		typeof navigator.credentials?.get === "function"
	);
}

export async function preparePasskey(
	signal: AbortSignal,
	conditional: boolean,
): Promise<
	| { status: "ready"; assertion: AuthenticationResponseJSON }
	| { status: "canceled" | "unavailable" | "failed" }
> {
	if (!passkeyAuthenticationSupported()) return { status: "unavailable" };
	try {
		if (
			conditional &&
			(!PublicKeyCredential.parseRequestOptionsFromJSON ||
				!PublicKeyCredential.prototype.toJSON ||
				!PublicKeyCredential.isConditionalMediationAvailable ||
				!(await PublicKeyCredential.isConditionalMediationAvailable()))
		)
			return { status: "unavailable" };
		if (signal.aborted) return { status: "canceled" };
		const options = await authClient.passkey.generateAuthenticateOptions({
			fetchOptions: { signal },
		});
		if (signal.aborted) return { status: "canceled" };
		if (options.error) return { status: "failed" };
		if (!conditional) {
			let ownsCeremony = true;
			const cancel = () => {
				if (ownsCeremony) WebAuthnAbortService.cancelCeremony();
			};
			signal.addEventListener("abort", cancel, { once: true });
			try {
				if (signal.aborted) return { status: "canceled" };
				// The installed manual-only helper enters native get synchronously, before its first await.
				const assertion = await startAuthentication({
					optionsJSON: { ...options.data, userVerification: "required" },
					useBrowserAutofill: false,
				});
				return signal.aborted
					? { status: "canceled" }
					: { status: "ready", assertion };
			} finally {
				ownsCeremony = false;
				signal.removeEventListener("abort", cancel);
			}
		}
		const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(
			options.data,
		);
		publicKey.userVerification = "required";
		const credential = await navigator.credentials.get({
			publicKey: { ...publicKey, allowCredentials: [] },
			mediation: "conditional",
			signal,
		});
		if (signal.aborted) return { status: "canceled" };
		if (
			!(credential instanceof PublicKeyCredential) ||
			!(credential.response instanceof AuthenticatorAssertionResponse)
		)
			return { status: "failed" };
		const json = credential.toJSON();
		if (json.type !== "public-key" || !("signature" in json.response))
			return { status: "failed" };
		return {
			status: "ready",
			assertion: {
				...json,
				type: "public-key",
				response: json.response,
				authenticatorAttachment:
					json.authenticatorAttachment === "platform" ||
					json.authenticatorAttachment === "cross-platform"
						? json.authenticatorAttachment
						: undefined,
			},
		};
	} catch {
		return { status: signal.aborted || conditional ? "canceled" : "failed" };
	}
}
