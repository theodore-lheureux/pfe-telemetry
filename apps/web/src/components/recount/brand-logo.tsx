import { cn } from "cn";

export function BrandLogo({
	className,
	variant = "lockup",
	label = "Recount",
}: {
	className?: string;
	variant?: "lockup" | "symbol";
	label?: string;
}) {
	const symbol = variant === "symbol";
	const imageClass = symbol ? "size-full" : "h-7 w-auto max-w-[140px] shrink-0";
	return (
		<span
			role="img"
			aria-label={label}
			className={cn("inline-flex shrink-0", symbol && "size-6", className)}
		>
			<img
				src={`/brand/recount-${variant}-on-light.svg`}
				alt=""
				width={symbol ? 24 : 120}
				height={symbol ? 24 : 28}
				className={cn(imageClass, "dark:hidden")}
			/>
			<img
				src={`/brand/recount-${variant}-on-dark.svg`}
				alt=""
				width={symbol ? 24 : 120}
				height={symbol ? 24 : 28}
				className={cn(imageClass, "hidden dark:block")}
			/>
		</span>
	);
}
