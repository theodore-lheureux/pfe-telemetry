import { cn } from "../lib/utils";

export function TooltipSwatch({
	color,
	block = false,
	faded = false,
}: {
	color: string;
	block?: boolean;
	faded?: boolean;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"shrink-0",
				block ? "size-2.5 rounded-[2px]" : "h-0.5 w-3 rounded-full",
				faded && "opacity-50",
			)}
			style={{ background: color }}
		/>
	);
}
