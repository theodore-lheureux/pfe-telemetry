export interface AuthenticationState {
	twoFactorPending: boolean;
	observedAt: Date;
	freshAgeSeconds: number;
	session: {
		id: string;
		createdAt: Date;
		expiresAt: Date;
		user: { id: string; email: string; emailVerified: boolean };
	} | null;
}

export interface AuthenticationRecovery {
	baseline: AuthenticationState;
	email?: string;
	method: "verify" | "passkey" | "two-factor";
}

export function provesNewAuthentication(
	baseline: AuthenticationState,
	current: AuthenticationState,
	email?: string,
) {
	const session = current.session;
	if (!session?.user.emailVerified || session.id === baseline.session?.id)
		return false;
	if (email && session.user.email.toLowerCase() !== email.toLowerCase())
		return false;
	const created = session.createdAt.getTime();
	const observed = current.observedAt.getTime();
	return (
		Number.isFinite(created) &&
		created >= baseline.observedAt.getTime() &&
		created <= observed &&
		session.expiresAt.getTime() > observed &&
		observed - created < current.freshAgeSeconds * 1000
	);
}
