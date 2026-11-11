import { type NavigateFn, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { mutationRefreshFailed } from "../lib/mutation-refresh";
import { useMutationBoundary, useMutationNotice } from "./mutation-feedback";

type Retirement = "navigation" | "identity" | "document";

export function useMutationOwner(userId: string) {
	const router = useRouter();
	const capture = useMutationBoundary();
	const publishNotice = useMutationNotice();
	const mounted = useRef(false);
	const active = useRef<{
		phase: "saving" | "refreshing" | "finished";
		retire: (reason: Retirement) => void;
		dispose: () => void;
	} | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			// Acknowledged reloads belong to the document, not the removed form.
			if (active.current?.phase !== "refreshing") {
				active.current?.retire("navigation");
				active.current?.dispose();
			}
		};
	}, []);

	function begin(onRetire: (reason: Retirement) => void = () => {}) {
		const boundary = capture();
		if (
			!mounted.current ||
			!boundary ||
			(active.current && active.current.phase !== "finished")
		)
			return null;
		active.current?.dispose();
		const controller = new AbortController();
		let origin = router.state.location.href;
		let destination: string | undefined;
		const sameAccount = () =>
			!router.state.matches.some(
				(match) => "user" in match.context && match.context.user.id !== userId,
			);
		const ownsRefresh = () =>
			!controller.signal.aborted &&
			!boundary.aborted &&
			sameAccount() &&
			router.state.location.href === origin;
		const current = () => mounted.current && ownsRefresh();
		let clearNotice: (() => void) | undefined;
		const operation = {
			phase: "saving" as "saving" | "refreshing" | "finished",
			retire(reason: Retirement) {
				if (controller.signal.aborted && reason === "navigation") return;
				// Aborting delivery does not establish whether the server committed.
				controller.abort(reason);
				operation.phase = "finished";
				if (reason !== "navigation") clearNotice?.();
				if (mounted.current) onRetire(reason);
				stop();
			},
			dispose() {
				controller.abort("navigation");
				stop();
				boundary.removeEventListener("abort", retireBoundary);
			},
		};
		const retireBoundary = () =>
			operation.retire(boundary.reason as Retirement);
		boundary.addEventListener("abort", retireBoundary, { once: true });
		const stop = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
			if (toLocation.href === origin) return;
			if (toLocation.href === destination) {
				origin = toLocation.href;
				destination = undefined;
			} else operation.retire("navigation");
		});
		active.current = operation;
		const navigate: NavigateFn = async (options) => {
			if (!ownsRefresh()) return;
			destination = router.buildLocation({
				...options,
				leaveParams: false,
			}).href;
			await router.navigate(options);
		};
		return {
			current,
			signal: controller.signal,
			async refresh(
				saved: string,
				unavailable: string,
				afterRefresh?: (navigate: NavigateFn) => Promise<void>,
				transientNotice = false,
			) {
				if (!current()) return false;
				const notice = publishNotice(saved, transientNotice);
				clearNotice = notice.clear;
				operation.phase = "refreshing";
				try {
					await router.invalidate({ sync: true });
					if (!ownsRefresh()) return false;
					await afterRefresh?.(navigate);
					if (!ownsRefresh()) return false;
					if (mutationRefreshFailed(router)) {
						notice.update(unavailable);
						return false;
					}
					notice.clear();
					return true;
				} catch (error) {
					if (ownsRefresh()) notice.update(unavailable);
					throw error;
				}
			},
			finish() {
				operation.phase = "finished";
				if (!mounted.current) operation.dispose();
			},
		};
	}
	return { router, begin };
}
