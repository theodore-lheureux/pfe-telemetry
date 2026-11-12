import { m } from "@recount/i18n/messages";
import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { FormFeedback } from "../../components/form-feedback";
import { TagInput } from "../../components/tag-input";
import { Button } from "../../components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../../components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { useAppMutation } from "../../components/use-app-mutation";
import type { ProjectReference } from "../../organizations/contracts";
import { updateInsightTags } from "../analytics.functions";
import {
	type SavedInsight,
	TAG_MODES,
	type TagMode,
	type UpdateInsightTagsInput,
} from "../saved-insights";

const MODE_LABEL: Record<TagMode, () => string> = {
	add: m.saved_tags_add,
	remove: m.saved_tags_remove,
	replace: m.saved_tags_replace,
};
const APPLY_LABEL: Record<TagMode, () => string> = {
	add: m.saved_tags_apply_add,
	remove: m.saved_tags_apply_remove,
	replace: m.saved_tags_apply_replace,
};

/** Adds, removes or replaces tags on the selected insights at once. */
export function TagUpdate({
	userId,
	reference,
	insights,
	suggestions,
	onUpdated,
}: {
	userId: string;
	reference: ProjectReference;
	insights: SavedInsight[];
	suggestions: string[];
	onUpdated: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<TagMode>("add");
	const [tags, setTags] = useState<string[]>([]);
	const mutation = useAppMutation({
		userId,
		saved:
			insights.length === 1
				? m.saved_tags_updated_one()
				: m.saved_tags_updated_many({ count: insights.length }),
		transientNotice: true,
		save: (data: UpdateInsightTagsInput, signal) =>
			updateInsightTags({ data, signal }),
	});
	const close = () => {
		setOpen(false);
		setTags([]);
		mutation.clearMessage();
	};
	const apply = async () => {
		const result = await mutation.submit({
			...reference,
			insightIds: insights.map((insight) => insight.id),
			mode,
			tags,
		});
		if (result && !result.error && (await result.refresh())) {
			close();
			onUpdated();
		}
	};
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (mutation.pending) return;
				if (next) setOpen(true);
				else close();
			}}
		>
			<PopoverTrigger asChild>
				<Button variant="outline">
					<PencilIcon aria-hidden="true" />
					{m.saved_tags_update()}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="flex w-80 flex-col gap-3">
				<p className="text-sm font-medium">
					{insights.length === 1
						? m.saved_tags_update_one()
						: m.saved_tags_update_many({ count: insights.length })}
				</p>
				<ToggleGroup
					type="single"
					variant="outline"
					spacing={0}
					className="w-full"
					value={mode}
					aria-label={m.saved_tags_mode()}
					onValueChange={(next) => {
						if (next) setMode(next as TagMode);
					}}
				>
					{TAG_MODES.map((entry) => (
						<ToggleGroupItem key={entry} value={entry} className="flex-1">
							{MODE_LABEL[entry]()}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				<TagInput
					tags={tags}
					onChange={setTags}
					label={m.tags()}
					suggestions={suggestions}
					disabled={mutation.pending}
				/>
				<FormFeedback
					message={mutation.kind === "success" ? "" : mutation.message}
					kind="error"
					reserveLine={false}
				/>
				<div className="flex justify-end gap-2">
					<Button variant="outline" disabled={mutation.pending} onClick={close}>
						{m.cancel()}
					</Button>
					<Button
						disabled={mutation.pending || (!tags.length && mode !== "replace")}
						pending={mutation.pending}
						pendingLabel={m.saving()}
						onClick={() => void apply()}
					>
						{APPLY_LABEL[mode]()}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
