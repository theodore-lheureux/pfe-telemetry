import {
	type AuthQueryAtom,
	getGlobalBroadcastChannel,
} from "better-auth/client";
import { authClient } from "./client";

function identityAtom(name: "session" | "listPasskeys") {
	return authClient.$store.atoms[name] as AuthQueryAtom<unknown>;
}

export function broadcastBetterAuthIdentity() {
	if (typeof window !== "undefined")
		getGlobalBroadcastChannel().post({
			event: "session",
			data: { trigger: "getSession" },
			clientId: crypto.randomUUID(),
		});
}

export function clearBetterAuthIdentity() {
	for (const name of ["session", "listPasskeys"] as const) {
		const atom = identityAtom(name);
		atom.set({
			...atom.get(),
			data: null,
			error: null,
			isPending: true,
			isRefetching: false,
		});
	}
	broadcastBetterAuthIdentity();
}

export async function refreshBetterAuthIdentity() {
	clearBetterAuthIdentity();
	// Starting fresh requests supersedes old flights; notifying a signal alone retains data.
	const requests = Promise.allSettled(
		(["session", "listPasskeys"] as const).map((name) =>
			identityAtom(name).get().refetch(),
		),
	);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			requests,
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, 10_000);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
	for (const name of ["session", "listPasskeys"] as const) {
		const atom = identityAtom(name);
		if (atom.get().error) atom.set({ ...atom.get(), data: null });
	}
}
