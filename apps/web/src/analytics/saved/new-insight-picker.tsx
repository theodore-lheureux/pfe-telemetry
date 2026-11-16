import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../components/ui/card";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../../components/ui/popover";
import type { ProjectReference } from "../../organizations/contracts";
import { ChartTypePreview } from "../insight/chart-type-preview";
import { DEFAULT_DRAFT, type DisplayType, encodeDraft } from "../insight/draft";
import { DISPLAY_ICON, DISPLAY_LABEL } from "../insight/labels";

const DESCRIPTION: Record<DisplayType, () => string> = {
	line: m.saved_create_line,
	area: m.saved_create_area,
	bar: m.saved_create_bar,
	stacked: m.saved_create_stacked,
	stat: m.saved_create_stat,
	table: m.saved_create_table,
};

export function NewInsightPicker({
	reference,
}: {
	reference: ProjectReference;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button aria-label={m.saved_new()}>
					<PlusIcon aria-hidden="true" />
					{m.saved_create()}
					<ChevronDownIcon aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				aria-label={m.saved_new()}
				className="w-[min(48rem,calc(100vw-2rem))] max-h-(--radix-popover-content-available-height) gap-4 overflow-y-auto p-4"
			>
				<div>
					<h2 className="font-semibold">{m.saved_create_heading()}</h2>
					<p className="mt-1 text-muted-foreground">
						{m.saved_create_description()}
					</p>
				</div>
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
					{(Object.keys(DISPLAY_LABEL) as DisplayType[]).map((type) => {
						const Icon = DISPLAY_ICON[type];
						const label = DISPLAY_LABEL[type]();
						return (
							<Link
								key={type}
								to="/organizations/$organizationId/projects/$projectId/explore"
								params={reference}
								search={{
									q: encodeDraft({
										...DEFAULT_DRAFT,
										display: { ...DEFAULT_DRAFT.display, type },
									}),
								}}
								aria-label={label}
								onClick={() => setOpen(false)}
								className="rounded-xl outline-none transition-shadow hover:ring-2 hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Card className="h-full gap-0 py-0">
									<ChartTypePreview type={type} />
									<CardHeader className="gap-1 border-t py-3">
										<CardTitle className="flex items-center gap-2">
											<Icon
												aria-hidden="true"
												className="size-4 shrink-0 text-primary"
											/>
											{label}
										</CardTitle>
										<CardDescription>{DESCRIPTION[type]()}</CardDescription>
									</CardHeader>
								</Card>
							</Link>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
