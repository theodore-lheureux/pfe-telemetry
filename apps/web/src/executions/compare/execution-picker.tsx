import { m } from "@recount/i18n/messages";
import { ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";
import { PICKER_CONTENT_CLASS } from "../../analytics/picker-command";
import { Button } from "../../components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../../components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../../components/ui/popover";
import { Skeleton } from "../../components/ui/skeleton";
import type { ProjectReference } from "../../organizations/contracts";
import { SideSwatch } from "./side-swatch";
import { useExecutionChoices } from "./use-execution-choices";

/** Chooses one execution of the project, searched by name or key. */
export function ExecutionPicker({
	userId,
	reference,
	label,
	side,
	selected,
	other,
	onSelect,
}: {
	userId: string;
	reference: ProjectReference;
	label: string;
	side: number;
	/** The chosen execution's key and name, when there is one. */
	selected: { key: string; name: string } | null;
	/** The execution on the other side, which cannot be compared with itself. */
	other: string | undefined;
	onSelect: (key: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const choices = useExecutionChoices(userId, reference, open);
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<span className="flex items-center gap-2 text-sm font-medium">
				<SideSwatch side={side} />
				{label}
			</span>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						role="combobox"
						aria-expanded={open}
						aria-label={`${label}: ${selected?.name ?? m.execution_compare_choose()}`}
						className="w-full justify-between font-normal"
					>
						<span className="min-w-0 truncate text-left">
							{selected ? (
								selected.name
							) : (
								<span className="text-muted-foreground">
									{m.execution_compare_choose()}
								</span>
							)}
						</span>
						<ChevronsUpDownIcon aria-hidden="true" className="opacity-60" />
					</Button>
				</PopoverTrigger>
				<PopoverContent className={PICKER_CONTENT_CLASS} align="start">
					<Command>
						<CommandInput placeholder={m.execution_compare_search()} />
						<CommandList>
							{choices.isPending ? (
								<div className="grid gap-2 p-2" aria-hidden="true">
									<Skeleton className="h-8" />
									<Skeleton className="h-8" />
									<Skeleton className="h-8" />
								</div>
							) : (
								<CommandEmpty>
									{choices.isError
										? m.execution_compare_choices_failed()
										: m.execution_compare_no_match()}
								</CommandEmpty>
							)}
							<CommandGroup>
								{choices.executions.map((execution) => (
									<CommandItem
										key={execution.executionKey}
										value={execution.executionKey}
										keywords={[execution.name]}
										disabled={execution.executionKey === other}
										data-checked={execution.executionKey === selected?.key}
										onSelect={() => {
											onSelect(execution.executionKey);
											setOpen(false);
										}}
									>
										<span className="flex min-w-0 flex-col">
											<span className="truncate">{execution.name}</span>
											<code className="truncate text-xs text-muted-foreground">
												{execution.executionKey}
											</code>
										</span>
									</CommandItem>
								))}
								{choices.hasNextPage && (
									<CommandItem
										value="~more"
										// Stays listed while searching, so unloaded pages remain reachable.
										forceMount
										disabled={choices.isFetchingNextPage}
										onSelect={() => void choices.fetchNextPage()}
										className="justify-center text-muted-foreground"
									>
										{m.execution_compare_load_more()}
									</CommandItem>
								)}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</div>
	);
}
