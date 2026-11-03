import { cn } from "cn";

const imageClass = "h-7 w-auto max-w-[140px] shrink-0";

export function BrandLogo({ className }: { className?: string }) {
	return (
		<span
			role="img"
			aria-label="Recount"
			className={cn("inline-flex shrink-0", className)}
		>
			<img
				src="/brand/recount-lockup-on-light.svg"
				alt=""
				width={120}
				height={28}
				className={cn(imageClass, "dark:hidden")}
			/>
			<img
				src="/brand/recount-lockup-on-dark.svg"
				alt=""
				width={120}
				height={28}
				className={cn(imageClass, "hidden dark:block")}
			/>
		</span>
	);
}
