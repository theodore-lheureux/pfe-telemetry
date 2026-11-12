import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowLeftIcon, ChevronDownIcon, PencilIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { FormFeedback } from "../../components/form-feedback";
import { TagList } from "../../components/tag-list";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonGroup } from "../../components/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "../../components/ui/input-group";
import { Textarea } from "../../components/ui/textarea";
import { useAppMutation } from "../../components/use-app-mutation";
import { addTag, withoutTags } from "../../lib/tags";
import type { ProjectReference } from "../../organizations/contracts";
import { saveInsight } from "../analytics.functions";
import {
	decodeDraft,
	encodeDraft,
	type InsightDraft,
	sameDraft,
} from "../insight/draft";
import { DISPLAY_ICON, plottedNames } from "../insight/labels";
import {
	MAX_INSIGHT_DESCRIPTION,
	MAX_INSIGHT_NAME,
	type SavedInsight,
	type SaveInsightInput,
} from "../saved-insights";
import { InsightNameDialog } from "./name-dialog";

const SAVED =
	"/organizations/$organizationId/projects/$projectId/insights/saved";
const EXPLORE =
	"/organizations/$organizationId/projects/$projectId/insights/explore" as const;

/**
 * The open insight's editable name and description with its save actions, laid out
 * for the page header: the name row stays pinned and the description sits below it.
 */
export function useInsightTitle({
	userId,
	reference,
	canWrite,
	saved,
	draft,
	tagSuggestions,
}: {
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	/** The saved insight being edited, or null for a new one. */
	saved: SavedInsight | null;
	draft: InsightDraft;
	/** Tags used by other insights of the project. */
	tagSuggestions: string[];
}) {
	const mutation = useAppMutation({
		userId,
		saved: m.saved_saved(),
		transientNotice: true,
		save: (data: SaveInsightInput, signal) => saveInsight({ data, signal }),
	});
	const pending = mutation.pending;
	const error = mutation.kind === "success" ? "" : mutation.message;
	const [name, setName] = useState(saved?.name ?? "");
	const [description, setDescription] = useState(saved?.description ?? "");
	const [tags, setTags] = useState(saved?.tags ?? []);
	const [copying, setCopying] = useState(false);
	// Opening another insight, or saving a new one, starts from what was stored.
	useEffect(() => {
		setName(saved?.name ?? "");
		setDescription(saved?.description ?? "");
		setTags(saved?.tags ?? []);
	}, [saved?.name, saved?.description, saved?.tags]);
	// An unnamed insight is named after what it plots, as its placeholder shows.
	const suggested = (plottedNames(draft).join(", ") || m.saved_new()).slice(
		0,
		MAX_INSIGHT_NAME,
	);
	const finalName = name.trim() || suggested;
	const changed =
		saved !== null &&
		(!sameDraft(decodeDraft(saved.draft), draft) ||
			finalName !== saved.name ||
			description.trim() !== saved.description ||
			tags.join("\n") !== saved.tags.join("\n"));
	const complete = draft.series.every((series) => series.metric);
	// Solid while there is something to save; outlined otherwise, so the menu half
	// still reads as part of one control.
	const savable = complete && (saved === null || changed);
	const variant = savable ? "default" : "outline";
	const Icon = DISPLAY_ICON[draft.display.type];

	const save = async (insightId: string, as: string) => {
		const result = await mutation.submit({
			...reference,
			insightId,
			name: as,
			description: description.trim(),
			tags,
			draft: encodeDraft(draft),
		});
		if (!result || result.error) return;
		// A new insight takes over the URL; its saved draft replaces `q`.
		if (insightId === saved?.id) await result.refresh();
		else
			await result.refresh(async (navigate) => {
				setCopying(false);
				await navigate({
					to: EXPLORE,
					params: reference,
					search: { insight: insightId },
					replace: true,
					resetScroll: false,
				});
			});
	};

	const heading = (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<Button asChild variant="ghost" size="icon-sm">
				<Link to={SAVED} params={reference} aria-label={m.saved_back()}>
					<ArrowLeftIcon aria-hidden="true" />
				</Link>
			</Button>
			<Icon aria-hidden="true" className="size-5 shrink-0 text-primary" />
			<h1 className={canWrite ? "sr-only" : "truncate text-xl font-semibold"}>
				{saved?.name ?? suggested}
			</h1>
			{canWrite && (
				<InputGroup className="h-8 min-w-0 flex-1 bg-card hover:border-ring/60">
					<InputGroupInput
						aria-label={m.saved_name()}
						value={name}
						placeholder={suggested}
						maxLength={MAX_INSIGHT_NAME}
						autoComplete="off"
						className="h-full px-2.5 text-base font-semibold md:text-base"
						onChange={(event) => setName(event.target.value)}
					/>
					<InputGroupAddon align="inline-end">
						<PencilIcon aria-hidden="true" className="size-3.5" />
					</InputGroupAddon>
				</InputGroup>
			)}
			{changed && <Badge variant="secondary">{m.saved_unsaved()}</Badge>}
			{!canWrite && <Badge variant="outline">{m.saved_view_only()}</Badge>}
			{canWrite && (
				<ButtonGroup className="ml-auto shrink-0">
					<Button
						variant={variant}
						// Both halves share one look and join without inner corners.
						className={saved ? "rounded-r-none!" : undefined}
						disabled={pending || !savable}
						pending={pending && !copying}
						pendingLabel={m.saving()}
						onClick={() =>
							void save(saved?.id ?? crypto.randomUUID(), finalName)
						}
					>
						{m.saved_save()}
					</Button>
					{saved && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									size="icon"
									variant={variant}
									aria-label={m.saved_more_save()}
									disabled={!complete || pending}
									className={cn(
										"rounded-l-none!",
										variant === "default" && "border-l-primary-foreground/25",
									)}
								>
									<ChevronDownIcon aria-hidden="true" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onSelect={() => {
										mutation.clearMessage();
										setCopying(true);
									}}
								>
									{m.saved_save_as()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</ButtonGroup>
			)}
		</div>
	);

	const details = (
		<div className="flex flex-col gap-2">
			{canWrite ? (
				<Textarea
					aria-label={m.saved_description()}
					value={description}
					placeholder={m.saved_description_placeholder()}
					maxLength={MAX_INSIGHT_DESCRIPTION}
					rows={1}
					className="min-h-8 resize-none px-2.5 py-1.5 text-sm field-sizing-content md:text-sm"
					onChange={(event) => setDescription(event.target.value)}
				/>
			) : (
				saved?.description && (
					<p className="text-sm whitespace-pre-line text-muted-foreground">
						{saved.description}
					</p>
				)
			)}
			<TagList
				tags={tags}
				editable={canWrite}
				suggestions={tagSuggestions}
				onAdd={(tag) => {
					const added = addTag(tags, tag);
					if (added) setTags(added);
					return added !== null;
				}}
				onRemove={(tag) => setTags(withoutTags(tags, [tag]))}
			/>
			{!complete && canWrite && (
				<p className="text-xs text-muted-foreground">{m.saved_incomplete()}</p>
			)}
			{!copying && (
				<FormFeedback message={error} kind="error" reserveLine={false} />
			)}
			<InsightNameDialog
				open={copying}
				title={m.saved_save_as()}
				initialName={m.saved_copy_name({ name: finalName })}
				pending={pending}
				error={error}
				onClose={() => setCopying(false)}
				onSubmit={(copy) => void save(crypto.randomUUID(), copy)}
			/>
		</div>
	);

	return { heading, description: details };
}
