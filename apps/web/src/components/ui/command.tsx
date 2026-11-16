import { Command as CommandPrimitive } from "cmdk";
import { cn } from "cn";
import { CheckIcon, SearchIcon } from "lucide-react";
import type * as React from "react";
import { InputGroup, InputGroupAddon } from "./input-group";

function Command({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			data-slot="command"
			className={cn(
				"flex size-full flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground",
				className,
			)}
			{...props}
		/>
	);
}
const COMMAND_INPUT_VARIANT = {
	filled: "border-input/30 bg-input/30",
	outline: "bg-transparent",
};

function CommandInput({
	className,
	endAddon,
	variant = "filled",
	...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
	endAddon?: React.ReactNode;
	/** Outline suits a search box shown in a page rather than in a popover. */
	variant?: keyof typeof COMMAND_INPUT_VARIANT;
}) {
	return (
		<div data-slot="command-input-wrapper" className="p-1 pb-0">
			<InputGroup
				className={cn(
					"h-8! rounded-lg! shadow-none! *:data-[slot=input-group-addon]:pl-2!",
					COMMAND_INPUT_VARIANT[variant],
				)}
			>
				<CommandPrimitive.Input
					data-slot="command-input"
					className={cn(
						"min-w-0 flex-1 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
						className,
					)}
					{...props}
				/>
				<InputGroupAddon>
					<SearchIcon
						aria-hidden="true"
						className="size-4 shrink-0 opacity-50"
					/>
				</InputGroupAddon>
				{endAddon && (
					<InputGroupAddon
						align="inline-end"
						className="shrink-0 self-stretch border-l py-0! pr-0! pl-0!"
					>
						{endAddon}
					</InputGroupAddon>
				)}
			</InputGroup>
		</div>
	);
}
function CommandList({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
	return (
		<CommandPrimitive.List
			data-slot="command-list"
			className={cn(
				"no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
				className,
			)}
			{...props}
		/>
	);
}
function CommandEmpty({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
	return (
		<CommandPrimitive.Empty
			data-slot="command-empty"
			className={cn("py-6 text-center text-sm", className)}
			{...props}
		/>
	);
}
function CommandGroup({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group
			data-slot="command-group"
			className={cn(
				"overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
				className,
			)}
			{...props}
		/>
	);
}
function CommandItem({
	className,
	children,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			data-slot="command-item"
			className={cn(
				"group/command-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-muted data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-selected:*:[svg]:text-foreground",
				className,
			)}
			{...props}
		>
			{children}
			<CheckIcon
				aria-hidden="true"
				className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100"
			/>
		</CommandPrimitive.Item>
	);
}

export {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
};
