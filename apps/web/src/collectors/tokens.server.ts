import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";

export const ACCESS_TOKEN_SECONDS = 3600;
export const TOKEN_REQUEST_WINDOW_SECONDS = 120;
const AUDIENCE = "recount-ingestion";
const ISSUER = "recount";

// PKCS#8 wrapping for a raw 32-byte Ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from(
	"302e020100300506032b657004220420",
	"hex",
);

export interface AccessTokenClaims {
	sub: string;
	org: string;
	project: string;
	root: string;
	rootKind: number;
	adapter: "standard" | "linux";
	localKinds: number[];
	maxAge: number;
	skew: number;
}

export interface SigningKey {
	kid: string;
	privateKey: KeyObject;
	publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
}

export function readSigningKey(env = process.env): SigningKey {
	const seed = Buffer.from(
		env.RECOUNT_COLLECTOR_SIGNING_KEY ?? "",
		"base64url",
	);
	if (seed.length !== 32)
		throw new Error(
			"RECOUNT_COLLECTOR_SIGNING_KEY must be a base64url-encoded 32-byte Ed25519 seed",
		);
	const privateKey = createPrivateKey({
		key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
		format: "der",
		type: "pkcs8",
	});
	const { x } = createPublicKey(privateKey).export({ format: "jwk" });
	if (!x) throw new Error("Collector signing key has no public component");
	return {
		kid: createHash("sha256").update(x).digest("base64url").slice(0, 16),
		privateKey,
		publicJwk: { kty: "OKP", crv: "Ed25519", x },
	};
}

let cached: SigningKey | undefined;
export function signingKey() {
	cached ??= readSigningKey();
	return cached;
}

function encode(value: unknown) {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Compact JWS (EdDSA) that the ingestion service verifies without a database lookup. */
export function signAccessToken(
	claims: AccessTokenClaims,
	now = Math.floor(Date.now() / 1000),
	key = signingKey(),
) {
	const exp = now + ACCESS_TOKEN_SECONDS;
	const input = `${encode({ alg: "EdDSA", typ: "JWT", kid: key.kid })}.${encode(
		{
			...claims,
			iss: ISSUER,
			aud: AUDIENCE,
			iat: now,
			exp,
		},
	)}`;
	const signature = sign(null, Buffer.from(input), key.privateKey).toString(
		"base64url",
	);
	return { token: `${input}.${signature}`, expiresAt: new Date(exp * 1000) };
}

export function publicKeySet(key = signingKey()) {
	return {
		keys: [{ ...key.publicJwk, kid: key.kid, alg: "EdDSA", use: "sig" }],
	};
}

/** The bytes a node signs to request a token; the timestamp is whole Unix seconds. */
export function tokenRequestMessage(nodeId: string, timestamp: number) {
	return Buffer.from(`recount-collector-token\n${nodeId}\n${timestamp}`);
}

export function verifyNodeSignature(
	publicKey: string,
	message: Buffer,
	signature: string,
) {
	try {
		const key = createPublicKey({
			key: { kty: "OKP", crv: "Ed25519", x: publicKey },
			format: "jwk",
		});
		return verify(null, message, key, Buffer.from(signature, "base64url"));
	} catch {
		return false;
	}
}
