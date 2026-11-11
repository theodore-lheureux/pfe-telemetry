export const workspaceCookieName = (userId: string) =>
	`recount_workspace_${userId}`;
export interface WorkspacePreference {
	organizationId?: string;
	projects: Record<string, string>;
}

export function rememberWorkspacePreference(
	userId: string,
	project: { id: string; organizationId: string },
) {
	const name = workspaceCookieName(userId);
	const stored = document.cookie
		.split(";")
		.find((cookie) => cookie.trim().startsWith(`${name}=`))
		?.trim()
		.slice(name.length + 1);
	let previous: WorkspacePreference = { projects: {} };
	try {
		previous = readWorkspacePreference(
			stored ? decodeURIComponent(stored) : undefined,
		);
	} catch {
		/* Ignore malformed preference cookies. */
	}
	const projects = Object.fromEntries(
		[
			...Object.entries(previous.projects).filter(
				([id]) => id !== project.organizationId,
			),
			[project.organizationId, project.id],
		].slice(-16),
	);
	// biome-ignore lint/suspicious/noDocumentCookie: This per-account hint supports SSR; the server reauthorizes every selected scope.
	document.cookie = `${name}=${encodeURIComponent(JSON.stringify({ organizationId: project.organizationId, projects }))}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}
export function readWorkspacePreference(value?: string): WorkspacePreference {
	try {
		const input = JSON.parse(value ?? "{}");
		if (!input || typeof input !== "object" || Array.isArray(input))
			return { projects: {} };
		const organizationId =
			typeof input.organizationId === "string" &&
			input.organizationId.length <= 128
				? input.organizationId
				: undefined;
		const entries =
			input.projects &&
			typeof input.projects === "object" &&
			!Array.isArray(input.projects)
				? input.projects
				: {};
		const projects = Object.fromEntries(
			Object.entries(entries)
				.filter(
					([org, project]) =>
						org.length <= 128 &&
						typeof project === "string" &&
						project.length <= 128,
				)
				.slice(-16),
		) as Record<string, string>;
		return { organizationId, projects };
	} catch {
		return { projects: {} };
	}
}
