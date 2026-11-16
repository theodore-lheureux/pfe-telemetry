import { m } from "@recount/i18n/messages";
import { ArrowLeftIcon, type LucideIcon, PencilIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";

/**
 * A definition page: read first, with Edit switching the body to a form whose Save and
 * Cancel replace the page actions. The form owns its fields and submits through `formId`.
 */
export function DefinitionShell({
	back,
	icon,
	title,
	technicalName,
	actions,
	canWrite,
	editing,
	formId,
	pending,
	changed,
	onEdit,
	onCancel,
	children,
}: {
	/** A link back to the list, given the arrow to show before its label. */
	back: (arrow: ReactNode) => ReactNode;
	icon: LucideIcon;
	title: string;
	technicalName?: string;
	/** Links shown while reading, such as Open in Explore. */
	actions?: ReactNode;
	canWrite: boolean;
	editing: boolean;
	formId: string;
	pending: boolean;
	changed: boolean;
	onEdit: () => void;
	onCancel: () => void;
	children: ReactNode;
}) {
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<Button asChild variant="ghost" size="sm" className="-ml-2 self-start">
				{back(<ArrowLeftIcon aria-hidden="true" />)}
			</Button>
			<PageHeader
				icon={icon}
				title={title}
				description={
					technicalName ? (
						<code className="self-start rounded border bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground">
							{technicalName}
						</code>
					) : null
				}
				actions={
					editing ? (
						<>
							<Button variant="outline" disabled={pending} onClick={onCancel}>
								{m.cancel()}
							</Button>
							<Button
								type="submit"
								form={formId}
								disabled={!changed || pending}
								pending={pending}
								pendingLabel={m.saving()}
							>
								{m.definitions_save()}
							</Button>
						</>
					) : (
						<>
							{actions}
							{canWrite && (
								<Button variant="outline" onClick={onEdit}>
									<PencilIcon aria-hidden="true" />
									{m.definitions_edit()}
								</Button>
							)}
						</>
					)
				}
			/>
			{children}
		</section>
	);
}
