import { LazyLog } from "@melloware/react-logviewer";
import { m } from "@recount/i18n/messages";
import { cn } from "cn";

/** Fills its container; the default size suits the toolbar panel. */
export default function TaskLogViewer({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	return (
		<div
			className={cn("h-[360px] overflow-hidden rounded-lg border", className)}
		>
			<LazyLog
				text={text}
				enableSearch
				enableLineNumbers
				selectableLines
				enableLinks={false}
				enableHotKeys={false}
				style={{
					fontSize: 12,
					backgroundColor: "var(--sidebar)",
					color: "var(--foreground)",
				}}
				internacionalization={{
					searchBar: {
						searchPlaceholder: m.developer_log_search(),
						matchLabel: m.developer_log_match(),
						matchesLabel: m.developer_log_matches(),
						filterLinesTitle: m.developer_log_filter(),
						previousButtonTitle: m.developer_log_previous(),
						nextButtonTitle: m.developer_log_next(),
					},
				}}
			/>
		</div>
	);
}
