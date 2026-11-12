import { m } from "@recount/i18n/messages";
import { cn } from "cn";
import {
	CircleAlertIcon,
	CircleCheckIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type FeedbackKind = "success" | "error" | "warning";

const ICON = {
	error: CircleAlertIcon,
	warning: TriangleAlertIcon,
	success: CircleCheckIcon,
};
const TONE = {
	error: "text-destructive",
	warning: "text-foreground",
	success: "text-primary",
};
const LIVE_ROLE: Record<string, "alert" | "status"> = {
	true: "alert",
	false: "status",
};

export function FormFeedback({
	message,
	kind = "success",
	pending = false,
	pendingMessage = m.saving(),
	id,
	className,
	reserveLine = true,
}: {
	message: string;
	kind?: FeedbackKind;
	pending?: boolean;
	pendingMessage?: string;
	id?: string;
	className?: string;
	reserveLine?: boolean;
}) {
	const container = useRef<HTMLDivElement>(null);
	const [settledHeight, setSettledHeight] = useState(reserveLine ? 20 : 0);
	const text = pending ? pendingMessage : message;
	useEffect(() => {
		const element = container.current;
		if (!element || pending) return;
		const measure = () => {
			const height = Number.parseFloat(getComputedStyle(element).height);
			if (Number.isFinite(height))
				setSettledHeight(Math.max(reserveLine ? 20 : 0, height));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [pending, reserveLine]);
	const minimumHeight = pending ? settledHeight : Number(reserveLine) * 20;
	const Icon = ICON[kind];
	const assertive = !pending && kind === "error";
	return (
		<div
			ref={container}
			id={id}
			className={cn(
				className,
				!reserveLine && minimumHeight === 0 && (!text || pending) && "absolute",
			)}
			style={{ minHeight: minimumHeight }}
		>
			<p
				role={text ? LIVE_ROLE[String(assertive)] : undefined}
				aria-live={assertive ? "assertive" : "polite"}
				aria-atomic="true"
				className={cn(
					"flex items-start gap-2 text-sm",
					pending && "sr-only",
					pending ? "text-muted-foreground" : TONE[kind],
				)}
			>
				{text && !pending && (
					<Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
				)}
				{text}
			</p>
		</div>
	);
}
