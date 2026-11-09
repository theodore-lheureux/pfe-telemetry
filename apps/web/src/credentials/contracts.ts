import type { ProjectReference } from "../organizations/contracts";

export const NANOSECONDS_PER_SECOND = 1_000_000_000n;
export const MAX_U64_DURATION_NANOSECONDS = (1n << 64n) - 1n;
/** Largest whole-second duration representable as UInt64 nanoseconds. */
export const MAX_U64_NANOSECONDS_DURATION_SECONDS = Number(
	MAX_U64_DURATION_NANOSECONDS / NANOSECONDS_PER_SECOND,
);

export interface CreateCollectorCredentialInput extends ProjectReference {
	name: string;
	sourceId: string;
	rootId: string;
	rootKind?: number;
	adapter?: "standard" | "linux";
	allowedLocalKinds?: number[];
	additionalRoots?: RootGrantInput[];
	resources?: ResourceGrantInput[];
	maximumSubmissionAge?: number;
	allowedClockSkew?: number;
	expiresAt?: string | null;
}

export interface ResourceGrantInput {
	resourceId: string;
	resourceKind: number;
}
export interface RootGrantInput extends ResourceGrantInput {
	adapter: "standard" | "linux";
	allowedLocalKinds: number[];
}

export interface CollectorCredentialReference extends ProjectReference {
	credentialId: string;
}

export interface CollectorCredentialSummary extends ProjectReference {
	id: string;
	name: string;
	sourceId: string;
	rootId: string;
	rootKind: number;
	maximumSubmissionAge: number;
	allowedClockSkew: number;
	createdAt: Date;
	rotatedAt: Date | null;
	expiresAt: Date | null;
	revokedAt: Date | null;
}

export interface RevealedCollectorCredential {
	credential: CollectorCredentialSummary;
	token: string;
}
