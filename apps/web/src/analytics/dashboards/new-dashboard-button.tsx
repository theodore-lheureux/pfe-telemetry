import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { ButtonGroup } from "../../components/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import type { ProjectReference } from "../../organizations/contracts";
import { useAnalyticsCatalog } from "../catalog";
import { templateCoverage } from "../dashboard-templates";
import { useTemplateChoices } from "../dashboard-templates-query";

/** Creates a blank dashboard, or one from a template picked in the menu. */
export function NewDashboardButton({
	userId,
	reference,
	onCreate,
}: {
	userId: string;
	reference: ProjectReference;
	onCreate: (templateId?: string) => void;
}) {
	const hydrated = useHydrated();
	// Templates and their coverage load when the menu first opens.
	const [opened, setOpened] = useState(false);
	const { choices } = useTemplateChoices(userId, reference, opened);
	const catalog = useAnalyticsCatalog(userId, reference, opened);
	return (
		<ButtonGroup>
			<Button disabled={!hydrated} onClick={() => onCreate()}>
				<PlusIcon aria-hidden="true" />
				{m.dashboard_new()}
			</Button>
			<DropdownMenu onOpenChange={(open) => open && setOpened(true)}>
				<DropdownMenuTrigger asChild>
					<Button
						size="icon"
						disabled={!hydrated}
						aria-label={m.dashboard_new_from_template()}
					>
						<ChevronDownIcon aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-80">
					<DropdownMenuLabel>
						{m.dashboard_new_from_template()}
					</DropdownMenuLabel>
					{choices.map(({ id, template }) => (
						<DropdownMenuItem
							key={id}
							className="flex-col items-start gap-0.5"
							onSelect={() => onCreate(id)}
						>
							<span className="font-medium">{template.name}</span>
							{catalog.data && (
								<span className="text-xs text-muted-foreground">
									{m.dashboard_template_coverage(
										templateCoverage(template, catalog.data.metrics),
									)}
								</span>
							)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</ButtonGroup>
	);
}
