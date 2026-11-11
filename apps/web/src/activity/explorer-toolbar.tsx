import { m } from "@recount/i18n/messages";
import { RefreshCwIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import type { ProjectReference } from "../organizations/contracts";
import type { ExplorerColumnSettings } from "./columns";
import { ColumnsDialog } from "./columns-dialog";
import { ExplorerFilterBar, type ExplorerSelection } from "./explorer-filters";

/** Filters on the left; reload and column configuration on the right. */
export function ExplorerToolbar({
	userId,
	reference,
	hydrated,
	fetching,
	selection,
	columns,
	onSelection,
	onColumns,
	onReload,
}: {
	userId: string;
	reference: ProjectReference;
	hydrated: boolean;
	fetching: boolean;
	selection: ExplorerSelection;
	columns: ExplorerColumnSettings;
	onSelection: (selection: ExplorerSelection) => void;
	onColumns: (columns: ExplorerColumnSettings) => void;
	onReload: () => void;
}) {
	const [configuring, setConfiguring] = useState(false);
	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<ExplorerFilterBar
					userId={userId}
					reference={reference}
					value={selection}
					disabled={!hydrated}
					onChange={onSelection}
				/>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					disabled={!hydrated || fetching}
					onClick={onReload}
				>
					<RefreshCwIcon
						aria-hidden="true"
						className={fetching ? "motion-safe:animate-spin" : ""}
					/>
					{m.activity_reload()}
				</Button>
				<Button
					variant="outline"
					disabled={!hydrated}
					onClick={() => setConfiguring(true)}
				>
					<SlidersHorizontalIcon aria-hidden="true" />
					{m.activity_columns()}
				</Button>
				<ColumnsDialog
					open={configuring}
					onOpenChange={setConfiguring}
					userId={userId}
					reference={reference}
					settings={columns}
					onSaved={onColumns}
				/>
			</div>
		</>
	);
}
