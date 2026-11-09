import { cn } from "cn";
import { useState } from "react";
import type { getCurrentUser } from "../auth/session.functions";
import type { OrganizationSummary } from "../organizations/contracts";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

export type ApplicationUser = NonNullable<
	Awaited<ReturnType<typeof getCurrentUser>>
>;

export function initials(name: string) {
	return (
		name
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => Array.from(part)[0])
			.join("")
			.toUpperCase() || "?"
	);
}

function httpsImage(value: string | null | undefined) {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export function OrganizationAvatar({
	organization,
	className,
}: {
	organization?: OrganizationSummary;
	className?: string;
}) {
	return (
		<Avatar
			className={cn(
				"size-4 shrink-0 overflow-hidden rounded-xs text-[8px] after:rounded-xs",
				className,
			)}
			data-identity="organization"
			aria-hidden="true"
		>
			<AvatarImage
				src={httpsImage(organization?.logo)}
				alt=""
				referrerPolicy="no-referrer"
				className="rounded-none"
			/>
			<AvatarFallback className="rounded-none text-[length:inherit] leading-none">
				{organization ? initials(organization.name) : "—"}
			</AvatarFallback>
		</Avatar>
	);
}

export function ProjectAvatar({ name }: { name: string }) {
	return (
		<Avatar
			data-identity="project"
			aria-hidden="true"
			className="size-4 shrink-0 overflow-hidden rounded-xs after:rounded-xs"
		>
			<AvatarFallback className="rounded-none text-[8px] leading-none">
				{Array.from(initials(name))[0]}
			</AvatarFallback>
		</Avatar>
	);
}

export function UserAvatar({
	user,
	className,
	refresh = 0,
	imageSize = 64,
}: {
	user: ApplicationUser;
	className?: string;
	refresh?: number;
	imageSize?: number;
}) {
	const [imageFailed, setImageFailed] = useState(false);
	const canonical = httpsImage(user.image);
	const gravatar = new URL(user.gravatarUrl);
	gravatar.searchParams.set("s", String(imageSize));
	if (refresh) gravatar.searchParams.set("recount_refresh", String(refresh));
	return (
		<Avatar data-identity="user" className={className}>
			<AvatarImage
				src={!imageFailed && canonical ? canonical : gravatar.href}
				alt=""
				referrerPolicy="no-referrer"
				onLoadingStatusChange={(status) => {
					if (status === "error" && canonical) setImageFailed(true);
				}}
			/>
			<AvatarFallback>{initials(user.name || user.email)}</AvatarFallback>
		</Avatar>
	);
}
