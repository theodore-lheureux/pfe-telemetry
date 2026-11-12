import { m } from "@recount/i18n/messages";
import { cn } from "cn";
import { XIcon } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { addTag, hasTag, MAX_TAG_LENGTH, withoutTags } from "../lib/tags";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

/**
 * A field that collects tags inline: Enter or a comma adds what was typed, Backspace in
 * an empty field removes the last tag.
 */
export function TagInput({
	tags,
	onChange,
	label,
	suggestions = [],
	disabled,
	className,
}: {
	tags: string[];
	onChange: (tags: string[]) => void;
	label: string;
	suggestions?: string[];
	disabled?: boolean;
	className?: string;
}) {
	const id = useId();
	const [text, setText] = useState("");
	const offered = suggestions.filter((entry) => !hasTag(tags, entry));
	const commit = () => {
		const next = addTag(tags, text);
		if (next) onChange(next);
		if (next || !text.trim()) setText("");
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter" || event.key === ",") {
			event.preventDefault();
			commit();
		} else if (event.key === "Backspace" && !text && tags.length)
			onChange(tags.slice(0, -1));
	};
	return (
		<div
			className={cn(
				"flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-card px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
				disabled && "opacity-50",
				className,
			)}
		>
			{tags.map((tag) => (
				<Badge key={tag} variant="outline" className="gap-1">
					{tag}
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="size-4"
						disabled={disabled}
						aria-label={m.tag_remove({ tag })}
						onClick={() => onChange(withoutTags(tags, [tag]))}
					>
						<XIcon aria-hidden="true" className="size-3" />
					</Button>
				</Badge>
			))}
			<input
				aria-label={label}
				value={text}
				maxLength={MAX_TAG_LENGTH}
				disabled={disabled}
				autoComplete="off"
				placeholder={tags.length ? "" : m.tag_enter()}
				list={offered.length ? `${id}-suggestions` : undefined}
				className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground [&::-webkit-calendar-picker-indicator]:hidden"
				onChange={(event) => setText(event.target.value)}
				onKeyDown={onKeyDown}
				onBlur={commit}
			/>
			{offered.length > 0 && (
				<datalist id={`${id}-suggestions`}>
					{offered.map((entry) => (
						<option key={entry} value={entry} />
					))}
				</datalist>
			)}
		</div>
	);
}
