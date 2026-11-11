import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Page header that sticks to the top of the scrolling content area. Its bottom separator
 * fades in only while it is stuck, so the header reads as part of the page at rest.
 */
export function StickyHeader({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	// A zero-height marker sits where the header starts; once it scrolls out of view
	// the header is stuck. Ancestor overflow clipping counts, so no explicit root is needed.
	const marker = useRef<HTMLDivElement>(null);
	const [stuck, setStuck] = useState(false);
	useEffect(() => {
		const node = marker.current;
		if (!node) return;
		const observer = new IntersectionObserver(([entry]) =>
			setStuck(!entry.isIntersecting),
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	return (
		<>
			{/* Out of flow so a parent's flex gap does not add space above the header. */}
			<div
				ref={marker}
				aria-hidden="true"
				className="pointer-events-none absolute h-px w-px"
			/>
			<div
				data-stuck={stuck}
				className={cn(
					// Bleed into the page gutters so content scrolling underneath stays hidden;
					// negative block margins keep the resting layout unchanged.
					"sticky top-0 z-20 -mx-4 -mt-3 -mb-3 border-b border-transparent bg-background px-4 pt-3 pb-3 transition-[border-color] duration-200 data-[stuck=true]:border-border motion-reduce:transition-none md:-mx-6 md:px-6",
					// The mobile navigation button is fixed in the top-left corner.
					"max-md:data-[stuck=true]:pl-14",
					className,
				)}
			>
				{children}
			</div>
		</>
	);
}
