export async function settleIdentityRefresh(
	refresh: () => Promise<void>,
	timeoutMs = 10_000,
) {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			refresh(),
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, timeoutMs);
			}),
		]);
	} catch {
		/* Cleared private data must stay cleared when revalidation fails. */
	} finally {
		clearTimeout(timeout);
	}
}
