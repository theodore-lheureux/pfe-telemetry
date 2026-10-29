import type { ProjectReference } from "../organizations/contracts";

export interface CreateCollectorCredentialInput extends ProjectReference {
	name: string;
	sourceId: string;
	hosts: string[];
	requireHostId?: boolean;
	maximumSubmissionAge?: number;
	allowedClockSkew?: number;
	expiresAt?: string | null;
}

export interface CollectorCredentialReference extends ProjectReference {
	credentialId: string;
}

export interface CollectorCredentialSummary extends ProjectReference {
	id: string;
	name: string;
	sourceId: string;
	hosts: string[];
	requireHostId: boolean;
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
