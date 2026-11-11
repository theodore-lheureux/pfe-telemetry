import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { RadioIcon } from "lucide-react";
import { TimeDisplay } from "../components/time-display";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "../components/ui/sheet";
import type { ProjectReference } from "../organizations/contracts";
import type { PacketSummary } from "./contracts";
import { ActivityInspector } from "./inspector";
import { NodeLabel } from "./node-label";

/** A live packet's details in a side panel, while the list behind it stays frozen. */
export function PacketSheet({
	userId,
	reference,
	packet,
	onClose,
}: {
	userId: string;
	reference: ProjectReference;
	packet: PacketSummary | null;
	onClose: () => void;
}) {
	const numbers = new Intl.NumberFormat(getLocale());
	return (
		<Sheet
			open={packet !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<SheetContent className="w-full gap-0 p-0 data-[side=right]:sm:max-w-2xl">
				<SheetHeader className="border-b p-4 pr-12">
					<SheetTitle className="flex items-center gap-2">
						<RadioIcon aria-hidden="true" className="size-4 text-primary" />
						{m.activity_packet_label()}
					</SheetTitle>
					<SheetDescription className="flex flex-wrap items-center gap-x-4 gap-y-1">
						<NodeLabel node={packet?.nodes[0]} />
						{packet && (
							<>
								<TimeDisplay value={packet.receivedAt} mode="full" />
								<span>
									{m.activity_packet_counts({
										points: numbers.format(packet.points),
										metrics: numbers.format(packet.metrics),
									})}
								</span>
							</>
						)}
					</SheetDescription>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{packet && (
						<ActivityInspector
							key={packet.id}
							userId={userId}
							reference={reference}
							packet={packet}
						/>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
