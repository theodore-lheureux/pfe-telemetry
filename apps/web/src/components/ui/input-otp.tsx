"use client";

import { cn } from "cn";
import { OTPInput, OTPInputContext } from "input-otp";
import { type ComponentProps, useContext } from "react";

function InputOTP({
	className,
	containerClassName,
	...props
}: ComponentProps<typeof OTPInput> & { containerClassName?: string }) {
	return (
		<OTPInput
			data-slot="input-otp"
			containerClassName={cn(
				"flex items-center has-disabled:opacity-50",
				containerClassName,
			)}
			spellCheck={false}
			className={cn("disabled:cursor-not-allowed", className)}
			{...props}
		/>
	);
}

function InputOTPGroup({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="input-otp-group"
			className={cn("flex items-center gap-2", className)}
			{...props}
		/>
	);
}

function InputOTPSlot({
	index,
	className,
	...props
}: ComponentProps<"div"> & { index: number }) {
	const context = useContext(OTPInputContext);
	const { char, hasFakeCaret, isActive } = context?.slots[index] ?? {};
	return (
		<div
			data-slot="input-otp-slot"
			data-active={isActive}
			className={cn(
				"relative flex size-8 items-center justify-center rounded-md border border-muted-foreground text-sm font-medium outline-none transition-colors aria-invalid:border-destructive data-[active=true]:z-10 data-[active=true]:border-ring data-[active=true]:ring-3 data-[active=true]:ring-ring/50 dark:bg-input/30",
				className,
			)}
			{...props}
		>
			{char}
			{hasFakeCaret && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<div className="h-4 w-px animate-caret-blink bg-foreground duration-1000" />
				</div>
			)}
		</div>
	);
}

export { InputOTP, InputOTPGroup, InputOTPSlot };
