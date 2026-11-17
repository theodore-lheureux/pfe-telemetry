import { m } from "@recount/i18n/messages";
import { useRouter } from "@tanstack/react-router";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { cn } from "cn";
import {
	CircleCheckIcon,
	OctagonXIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { mutationRefreshFailed } from "../lib/mutation-refresh";
import type { FeedbackKind } from "./form-feedback";
import { useLocaleChangeBlocker } from "./locale-safety";
import { Button } from "./ui/button";
import { Toaster } from "./ui/sonner";

const NOTICE_ICON = {
	success: CircleCheckIcon,
	warning: TriangleAlertIcon,
	error: OctagonXIcon,
};
const NOTICE_TONE = {
	success: "text-primary",
	warning: "text-amber-700 dark:text-amber-400",
	error: "text-destructive",
};

// Styled like Sonner's toasts, but keeps status and alert roles for announcements.
function NoticeToast({
	kind,
	message,
	onDismiss,
}: {
	kind: FeedbackKind;
	message: string;
	onDismiss: () => void;
}) {
	const Icon = NOTICE_ICON[kind];
	return (
		<div className="flex w-[min(var(--width,356px),calc(100vw-2rem))] items-center gap-2.5 rounded-lg border bg-popover py-3 pr-2 pl-4 text-sm text-popover-foreground shadow-lg">
			<Icon
				aria-hidden="true"
				className={cn("size-4 shrink-0", NOTICE_TONE[kind])}
			/>
			<p
				role={kind === "error" ? "alert" : "status"}
				className="min-w-0 flex-1"
			>
				{message}
			</p>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				aria-label={m.dismiss_notice()}
				onClick={onDismiss}
			>
				<XIcon aria-hidden="true" />
			</Button>
		</div>
	);
}

interface MutationNotice {
	update: (message: string, kind?: FeedbackKind) => void;
	/** Turns the notice into a confirmation that dismisses itself. */
	settle: (message?: string) => void;
	clear: () => void;
}

// Long enough to read a short confirmation; failures stay until dismissed.
const CONFIRMATION_MS = 5000;

const FeedbackContext = createContext<{
	setMessage: (message: string | null, kind?: FeedbackKind) => void;
	publish: (
		message: string,
		transient?: boolean,
		kind?: FeedbackKind,
	) => MutationNotice;
	capture: () => AbortSignal | null;
} | null>(null);

export function MutationFeedback({ children }: { children: ReactNode }) {
	const router = useRouter();
	const nextId = useRef(0);
	const document = useRef({
		controller: new AbortController(),
		phase: "ready" as "ready" | "hidden" | "restoring",
	});
	const [notices, setNotices] = useState<
		{
			id: number;
			message: string;
			kind: FeedbackKind;
			origin?: string;
			settled?: boolean;
		}[]
	>([]);
	const capture = useCallback(
		() =>
			document.current.phase === "ready" &&
			!router.options.context.authentication.getSnapshot().pending
				? document.current.controller.signal
				: null,
		[router],
	);
	useEffect(() => {
		if (document.current.controller.signal.aborted)
			document.current.controller = new AbortController();
		const retire = (reason: "identity" | "document") => {
			document.current.controller.abort(reason);
			document.current.controller = new AbortController();
			setNotices([]);
		};
		const hide = () => {
			document.current.phase = "hidden";
			retire("document");
		};
		const show = (event: PageTransitionEvent) => {
			if (!event.persisted) return;
			document.current.phase = "restoring";
			const signal = document.current.controller.signal;
			void router
				.invalidate({ sync: true })
				.then(() => {
					if (!signal.aborted && !mutationRefreshFailed(router))
						document.current.phase = "ready";
				})
				.catch(() => {});
		};
		window.addEventListener("pagehide", hide);
		window.addEventListener("pageshow", show);
		const stop = router.subscribe("onBeforeNavigate", ({ toLocation }) =>
			setNotices((previous) =>
				previous.filter(
					(notice) => !notice.origin || notice.origin === toLocation.href,
				),
			),
		);
		const authentication = router.options.context.authentication;
		let revision = authentication.getSnapshot().revision;
		const currentActor = () =>
			router.state.matches.flatMap((match) =>
				"user" in match.context ? [match.context.user.id] : [],
			)[0];
		let actor: string | undefined = currentActor();
		const clearIdentity = () => {
			retire("identity");
			router.options.context.queryClient.clear();
		};
		const broadcast = getGlobalBroadcastChannel();
		const stopBroadcast = broadcast.setup();
		let queuedIdentityRefresh = false;
		let disposed = false;
		const unsubscribeBroadcast = broadcast.subscribe(() => {
			if (queuedIdentityRefresh) return;
			clearIdentity();
			actor = undefined;
			router.clearCache();
			if (document.current.phase === "hidden") return;
			document.current.phase = "restoring";
			queuedIdentityRefresh = true;
			// Better Auth can also own a storage listener while its session hook is mounted.
			queueMicrotask(() => {
				queuedIdentityRefresh = false;
				if (!disposed) void router.invalidate({ sync: true }).catch(() => {});
			});
		});
		const unsubscribe = authentication.subscribe(() => {
			if (
				authentication.getSnapshot().pending ||
				authentication.getSnapshot().revision !== revision
			) {
				retire("identity");
				actor = undefined;
			}
			revision = authentication.getSnapshot().revision;
		});
		const resolved = router.subscribe("onResolved", () => {
			const current = currentActor();
			if (actor !== undefined && current !== undefined && current !== actor)
				clearIdentity();
			actor = current ?? actor;
			if (
				document.current.phase === "restoring" &&
				!mutationRefreshFailed(router)
			)
				document.current.phase = "ready";
		});
		return () => {
			disposed = true;
			unsubscribeBroadcast();
			stopBroadcast();
			stop();
			unsubscribe();
			resolved();
			window.removeEventListener("pagehide", hide);
			window.removeEventListener("pageshow", show);
			document.current.controller.abort("document");
		};
	}, [router]);
	useLocaleChangeBlocker(notices.some((notice) => !notice.settled));
	// Notices render as toasts; the state stays authoritative so updates and
	// navigation-scoped clearing keep working.
	const shown = useRef(new Set<number>());
	useEffect(() => {
		const current = new Set(notices.map((notice) => notice.id));
		for (const id of shown.current)
			if (!current.has(id)) toast.dismiss(`notice-${id}`);
		for (const notice of notices) {
			const forget = () =>
				setNotices((previous) =>
					previous.filter((entry) => entry.id !== notice.id),
				);
			toast.custom(
				() => (
					<NoticeToast
						kind={notice.kind}
						message={notice.message}
						onDismiss={forget}
					/>
				),
				{
					id: `notice-${notice.id}`,
					duration: notice.settled ? CONFIRMATION_MS : Number.POSITIVE_INFINITY,
					onAutoClose: forget,
				},
			);
		}
		shown.current = current;
	}, [notices]);
	function setMessage(message: string | null, kind: FeedbackKind = "success") {
		setNotices(
			message
				? [
						{
							id: ++nextId.current,
							message,
							kind,
							settled: kind === "success",
						},
					]
				: [],
		);
	}
	function publish(
		message: string,
		transient = false,
		kind: FeedbackKind = "success",
	): MutationNotice {
		const id = ++nextId.current;
		// A new notice replaces confirmations that are still on screen.
		setNotices((previous) => [
			...previous.filter((notice) => !notice.settled),
			{
				id,
				message,
				kind,
				origin: transient ? router.state.location.href : undefined,
			},
		]);
		return {
			// Updating a dismissed notice must not bring it back.
			update: (message, kind = "warning") =>
				setNotices((previous) =>
					previous.map((notice) =>
						notice.id === id ? { ...notice, message, kind } : notice,
					),
				),
			settle: (message) =>
				setNotices((previous) =>
					previous.map((notice) =>
						notice.id === id
							? {
									...notice,
									message: message ?? notice.message,
									kind: "success",
									settled: true,
								}
							: notice,
					),
				),
			clear: () =>
				setNotices((previous) => previous.filter((notice) => notice.id !== id)),
		};
	}
	return (
		<FeedbackContext
			value={{
				setMessage,
				publish,
				capture,
			}}
		>
			{children}
			<Toaster position="bottom-right" />
		</FeedbackContext>
	);
}

export function useMutationFeedback() {
	const feedback = useContext(FeedbackContext);
	if (!feedback)
		throw new Error("Mutation feedback requires the document shell");
	return feedback.setMessage;
}

export function useOptionalMutationFeedback() {
	return useContext(FeedbackContext)?.setMessage;
}

export function useMutationNotice() {
	const feedback = useContext(FeedbackContext);
	if (!feedback)
		throw new Error("Mutation feedback requires the document shell");
	return feedback.publish;
}

export function useMutationBoundary() {
	const feedback = useContext(FeedbackContext);
	if (!feedback)
		throw new Error("Mutation ownership requires the document shell");
	return feedback.capture;
}
