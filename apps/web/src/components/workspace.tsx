import type { ReactNode } from "react";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "./ui/empty";

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
