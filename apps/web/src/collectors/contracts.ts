import type { ProjectReference } from "../organizations/contracts";

export const MAX_U64_NANOSECONDS_DURATION_SECONDS = 18_446_744_073;
export const DEFAULT_LINUX_LOCAL_KINDS = [4, 6];
export const LOCAL_KINDS = [2, 3, 4, 6, 8] as const;
export const MAX_NODES_PER_REQUEST = 500;
export const NODES_PER_PAGE = 100;

export type CollectorAdapter = "standard" | "linux";

export interface CreateEnrollmentKeyInput extends ProjectReference {
	name: string;
	adapter?: CollectorAdapter;
	allowedLocalKinds?: number[];
	maximumSubmissionAge?: number;
	allowedClockSkew?: number;
	maxNodes?: number | null;
	labels?: string[];
	expiresAt?: string | null;
}

export interface EnrollmentKeyReference extends ProjectReference {
	enrollmentKeyId: string;
}

export interface EnrollmentKeySummary extends ProjectReference {
	id: string;
	name: string;
	adapter: CollectorAdapter;
	allowedLocalKinds: number[];
	maximumSubmissionAge: number;
	allowedClockSkew: number;
	maxNodes: number | null;
	labels: string[];
	activeNodes: number;
	createdAt: Date;
	expiresAt: Date | null;
	revokedAt: Date | null;
}

export interface RevealedEnrollmentKey {
	enrollmentKey: EnrollmentKeySummary;
	key: string;
}

export type NodeStatus = "active" | "revoked" | "all";

export interface ListNodesInput extends ProjectReference {
	query?: string;
	status?: NodeStatus;
	page?: number;
}

export interface NodeSummary {
	id: string;
	enrollmentKeyId: string;
	enrollmentKeyName: string;
	machineId: string;
	hostname: string;
	labels: string[];
	collectorVersion: string;
	enrolledAt: Date;
	lastSeenAt: Date;
	revokedAt: Date | null;
}

export interface NodePage {
	nodes: NodeSummary[];
	total: number;
	page: number;
	pageSize: number;
}

export interface NodesReference extends ProjectReference {
	nodeIds: string[];
}

export interface EnrollNodeInput {
	enrollmentKey: string;
	machineId: string;
	hostname: string;
	publicKey: string;
	collectorVersion?: string;
}

export interface NodeTokenInput {
	nodeId: string;
	timestamp: number;
	signature: string;
}

export interface IssuedNodeToken {
	nodeId: string;
	organizationId: string;
	projectId: string;
	token: string;
	expiresAt: Date;
}
