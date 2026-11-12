import { m } from "@recount/i18n/messages";
import { cn } from "cn";
import { PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { hasTag, MAX_TAG_LENGTH, MAX_TAGS } from "../lib/tags";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * Tags as badges. When editable, each has a remove button and "Add tag" opens a small
 * form that suggests tags used elsewhere.
 */
export function TagList({
	tags,
	editable,
	disabled,
	suggestions = [],
	onAdd,
	onRemove,
	className,
}: {
	tags: string[];
	editable: boolean;
	disabled?: boolean;
	/** Existing tags offered while typing, such as those on other items. */
	suggestions?: string[];
	/** Resolves true once the tag is added, which closes the form. */
	onAdd?: (tag: string) => boolean | Promise<boolean>;
	onRemove?: (tag: string) => void;
	className?: string;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [tag, setTag] = useState("");
	const offered = suggestions.filter((entry) => !hasTag(tags, entry));
	return (
		<div className={cn("flex flex-wrap items-center gap-2", className)}>
			{tags.map((entry) => (
				<Badge key={entry} variant="outline" className="gap-1 py-1">
					{entry}
					{editable && (
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="size-4"
							disabled={disabled}
							aria-label={m.tag_remove({ tag: entry })}
							onClick={() => onRemove?.(entry)}
						>
							<XIcon aria-hidden="true" className="size-3" />
						</Button>
					)}
				</Badge>
			))}
			{editable && (
				<Popover
					open={open}
					onOpenChange={(next) => {
						if (!disabled) setOpen(next);
					}}
				>
					<PopoverTrigger asChild>
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="border-dashed"
							disabled={disabled || tags.length >= MAX_TAGS}
						>
							<PlusIcon aria-hidden="true" />
							{m.tag_add()}
						</Button>
					</PopoverTrigger>
					<PopoverContent align="start">
						<form
							method="post"
							className="flex flex-col gap-3"
							onSubmit={async (event) => {
								event.preventDefault();
								event.stopPropagation();
								if (await onAdd?.(tag.trim())) {
									setTag("");
									setOpen(false);
								}
							}}
						>
							<Label htmlFor={`${id}-tag`}>{m.tag()}</Label>
							<Input
								id={`${id}-tag`}
								value={tag}
								onChange={(event) => setTag(event.target.value)}
								required
								maxLength={MAX_TAG_LENGTH}
								disabled={disabled}
								autoComplete="off"
								list={offered.length ? `${id}-suggestions` : undefined}
							/>
							{offered.length > 0 && (
								<datalist id={`${id}-suggestions`}>
									{offered.map((entry) => (
										<option key={entry} value={entry} />
									))}
								</datalist>
							)}
							<Button type="submit" disabled={disabled || !tag.trim()}>
								{m.tag_save()}
							</Button>
						</form>
					</PopoverContent>
				</Popover>
			)}
		</div>
	);
}
