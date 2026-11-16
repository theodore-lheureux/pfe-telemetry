import {
	type DefinitionKind,
	DefinitionSourceIcon,
} from "./definition-source-icon";
import { attributeLabel, metricLabel } from "./metric-names";

/** Shared content for metric and attribute choices; identifiers stay in search keys. */
export function DefinitionChoice({
	kind,
	name,
	description,
	label: suppliedLabel,
}: {
	kind: DefinitionKind;
	name: string;
	description?: string;
	label?: string;
}) {
	const label =
		kind === "metric" ? metricLabel(name, suppliedLabel) : attributeLabel(name);
	return (
		<>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate font-medium">{label}</span>
				{description && (
					<span className="line-clamp-2 text-xs whitespace-normal text-muted-foreground">
						{description}
					</span>
				)}
			</span>
			<DefinitionSourceIcon kind={kind} name={name} className="order-first" />
		</>
	);
}
