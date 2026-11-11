import { cn } from "cn";
import type { ReactNode } from "react";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "./ui/empty";

export function PageHeading({
	title,
	children,
}: {
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			{children && (
				<p className="max-w-2xl text-sm text-muted-foreground">{children}</p>
			)}
		</div>
	);
}

export function EmptyState({
	title,
	children,
}: {
	title: string;
	children?: ReactNode;
}) {
	return (
		<Empty className="items-start border border-dashed bg-card p-5 text-left">
			<EmptyHeader className="items-start text-left">
				<EmptyTitle>
					<h2>{title}</h2>
				</EmptyTitle>
			</EmptyHeader>
			{children && (
				<EmptyContent className="items-start text-left">
					{children}
				</EmptyContent>
			)}
		</Empty>
	);
}

/** A centred empty or error state with an icon, such as a chart with nothing to show. */
export function IconEmptyState({
	icon,
	title,
	description,
	alert,
	className,
}: {
	icon: ReactNode;
	title: string;
	description?: ReactNode;
	/** Announces the description, for failures. */
	alert?: boolean;
	className?: string;
}) {
	return (
		<Empty
			className={cn(
				"border border-dashed",
				alert && "border-destructive/40",
				className,
			)}
		>
			<EmptyHeader>
				<EmptyMedia variant="icon">{icon}</EmptyMedia>
				<EmptyTitle>
					<h2>{title}</h2>
				</EmptyTitle>
				{description && (
					<EmptyDescription role={alert ? "alert" : undefined}>
						{description}
					</EmptyDescription>
				)}
			</EmptyHeader>
		</Empty>
	);
}
