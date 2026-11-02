import { isNotFound, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { useMutationNotice } from "../mutation-feedback";

export function useAdministrationOperation(userId: string) {
	const router = useRouter();
	const publishNotice = useMutationNotice();
	const lifetime = useRef({
		generation: 0,
		mounted: false,
		origin: "",
		refreshing: false,
		boundary: false,
		busy: false,
	});
	const clearNotice = useRef<(() => void) | null>(null);
	const failedRefresh = () =>
		router.state.matches.some(
			(match) =>
				match.status === "error" ||
				match.status === "notFound" ||
				isNotFound(match.error),
		);
	const sameAccount = useCallback(
		() =>
			!router.state.matches.some(
				(match) => "user" in match.context && match.context.user.id !== userId,
			),
		[router, userId],
	);
	useEffect(() => {
		const state = lifetime.current;
		state.generation++;
		state.mounted = true;
		return () => {
			state.mounted = false;
			// Only the refresh's own boundary may retain a saved-write acknowledgement.
			state.boundary =
				state.refreshing &&
				router.state.location.href === state.origin &&
				(router.state.isLoading ||
					router.state.matches.some(
						(match) =>
							match.status === "error" ||
							match.status === "notFound" ||
							isNotFound(match.error),
					)) &&
				sameAccount();
			if (!state.boundary) {
				state.generation++;
				if (!sameAccount()) clearNotice.current?.();
			}
		};
	}, [router, sameAccount]);

	function begin(onNavigate: () => void) {
		const state = lifetime.current;
		if (!state.mounted || state.busy) return null;
		state.busy = true;
		const generation = ++state.generation;
		const origin = router.state.location.href;
		const abortController = new AbortController();
		state.origin = origin;
		state.refreshing = false;
		state.boundary = false;
		const stop = router.subscribe(
			"onBeforeNavigate",
			({ fromLocation, toLocation }) => {
				if (state.generation !== generation || toLocation.href === origin)
					return;
				state.generation++;
				state.busy = false;
				if (!sameAccount()) clearNotice.current?.();
				// Cancelling the response does not imply that the server rolled back the write.
				abortController.abort();
				if (state.mounted && fromLocation?.pathname === toLocation.pathname)
					onNavigate();
			},
		);
		const current = () =>
			state.mounted &&
			state.generation === generation &&
			router.state.location.href === origin &&
			sameAccount();
		const ownsRefresh = () =>
			state.generation === generation &&
			router.state.location.href === origin &&
			(state.mounted || state.boundary) &&
			sameAccount();
		return {
			current,
			signal: abortController.signal,
			async refresh(saved: string, unavailable: string) {
				if (!current()) return false;
				const notice = publishNotice(saved);
				clearNotice.current = notice.clear;
				state.refreshing = true;
				try {
					await router.invalidate({ sync: true });
					if (!ownsRefresh()) {
						if (!sameAccount()) notice.clear();
						return false;
					}
					if (failedRefresh()) {
						notice.update(unavailable);
						return false;
					}
					if (!current()) return false;
					notice.clear();
					return true;
				} catch (error) {
					if (ownsRefresh()) notice.update(unavailable);
					else if (!sameAccount()) notice.clear();
					throw error;
				}
			},
			finish() {
				stop();
				if (state.generation === generation) state.busy = false;
			},
		};
	}
	return { router, begin };
}
