import { MonitorIcon } from "lucide-react";
import type { ActivityNode } from "./contracts";

export function NodeLabel({ node }: { node?: ActivityNode | null }) {
	return node ? (
		<span
			className="inline-flex max-w-64 items-center gap-2"
			title={`${node.id} · ${node.fingerprint}`}
		>
			<span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
				<MonitorIcon aria-hidden="true" className="size-2.5" />
			</span>
			<span className="truncate">{node.name}</span>
		</span>
	) : (
		<span className="text-muted-foreground">—</span>
	);
}
