import { m } from "@pfe/i18n/messages";
import {
	createContext,
	type ReactNode,
	useContext,
	useRef,
	useState,
} from "react";
import { useLocaleChangeBlocker } from "./locale-safety";
import { Button } from "./ui/button";

interface MutationNotice {
	update: (message: string) => void;
	clear: () => void;
}

const FeedbackContext = createContext<{
	setMessage: (message: string | null) => void;
	publish: (message: string) => MutationNotice;
} | null>(null);

export function MutationFeedback({ children }: { children: ReactNode }) {
	const nextId = useRef(0);
	const [notices, setNotices] = useState<{ id: number; message: string }[]>([]);
	useLocaleChangeBlocker(notices.length > 0);
	function setMessage(message: string | null) {
		setNotices(message ? [{ id: ++nextId.current, message }] : []);
	}
	function publish(message: string): MutationNotice {
		const id = ++nextId.current;
		setNotices((previous) => [...previous, { id, message }]);
		return {
			// Updating a dismissed notice must not bring it back.
			update: (message) =>
				setNotices((previous) =>
					previous.map((notice) =>
						notice.id === id ? { id, message } : notice,
					),
				),
			clear: () =>
				setNotices((previous) => previous.filter((notice) => notice.id !== id)),
		};
	}
	return (
		<FeedbackContext value={{ setMessage, publish }}>
			{notices.length > 0 && (
				<div className="flex flex-wrap items-center justify-center gap-3 border-b bg-muted px-6 py-3">
					<div role="status" className="text-sm">
						{notices.map((notice) => (
							<p key={notice.id}>{notice.message}</p>
						))}
					</div>
					<Button
						type="button"
						variant="ghost"
						onClick={() => setMessage(null)}
					>
						{m.dismiss_notice()}
					</Button>
				</div>
			)}
			{children}
		</FeedbackContext>
	);
}

export function useMutationFeedback() {
	const feedback = useContext(FeedbackContext);
	if (!feedback)
		throw new Error("Mutation feedback requires the document shell");
	return feedback.setMessage;
}

export function useMutationNotice() {
	const feedback = useContext(FeedbackContext);
	if (!feedback)
		throw new Error("Mutation feedback requires the document shell");
	return feedback.publish;
}
