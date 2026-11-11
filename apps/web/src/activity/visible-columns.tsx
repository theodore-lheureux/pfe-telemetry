import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { m } from "@recount/i18n/messages";
import { CheckIcon, GripVerticalIcon, PencilIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { cn } from "../lib/utils";
import { columnKey, columnName } from "./column-names";
import { type ExplorerColumn, isBuiltIn, MAX_COLUMN_LABEL } from "./columns";

function VisibleRow({
	column,
	removable,
	onRemove,
	onRename,
}: {
	column: ExplorerColumn;
	removable: boolean;
	onRemove: () => void;
	onRename: (label: string | undefined) => void;
}) {
	const id = useId();
	const sortable = useSortable({ id: column.field });
	const [editing, setEditing] = useState(false),
		[draft, setDraft] = useState("");
	const name = column.label ?? columnName(column.field);
	const commit = () => {
		const label = draft.trim();
		// An empty or unchanged name restores the field's own name.
		onRename(
			label && label !== columnName(column.field)
				? label.slice(0, MAX_COLUMN_LABEL)
				: undefined,
		);
		setEditing(false);
	};
	return (
		<li
			ref={sortable.setNodeRef}
			style={{
				transform: CSS.Translate.toString(sortable.transform),
				transition: sortable.transition,
			}}
			className={cn(
				"flex h-10 items-center gap-2 rounded-md border bg-muted/50 pr-1.5 pl-1",
				sortable.isDragging && "relative z-10 shadow-md",
			)}
		>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
				aria-label={m.columns_reorder({ name })}
				{...sortable.attributes}
				{...sortable.listeners}
			>
				<GripVerticalIcon aria-hidden="true" />
			</Button>
			{editing ? (
				<div className="flex min-w-0 flex-1 items-center gap-1">
					<Label htmlFor={`${id}-label`} className="sr-only">
						{m.columns_rename_label({ name: columnName(column.field) })}
					</Label>
					<Input
						id={`${id}-label`}
						value={draft}
						maxLength={MAX_COLUMN_LABEL}
						autoComplete="off"
						className="h-7"
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								// Renaming never submits the dialog.
								event.preventDefault();
								commit();
							}
							if (event.key === "Escape") {
								event.stopPropagation();
								setEditing(false);
							}
						}}
						autoFocus
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={m.columns_rename_apply()}
						onClick={() => commit()}
					>
						<CheckIcon aria-hidden="true" />
					</Button>
				</div>
			) : (
				<span className="flex min-w-0 flex-1 items-baseline gap-2">
					<span className="truncate">{name}</span>
					{(column.label || !isBuiltIn(column.field)) && (
						<span className="truncate font-mono text-[11px] text-muted-foreground">
							{columnKey(column.field)}
						</span>
					)}
				</span>
			)}
			{!editing && (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={m.columns_rename({ name })}
					onClick={() => {
						setDraft(name);
						setEditing(true);
					}}
				>
					<PencilIcon aria-hidden="true" />
				</Button>
			)}
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={m.columns_remove({ name })}
				disabled={!removable}
				onClick={onRemove}
				className="text-destructive hover:text-destructive"
			>
				<XIcon aria-hidden="true" />
			</Button>
		</li>
	);
}

/** The chosen columns, reordered by dragging or with the keyboard, renamed and removed. */
export function VisibleColumns({
	columns,
	onChange,
}: {
	columns: ExplorerColumn[];
	onChange: (columns: ExplorerColumn[]) => void;
}) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
	const move = ({ active, over }: DragEndEvent) => {
		if (!over || active.id === over.id) return;
		onChange(
			arrayMove(
				columns,
				columns.findIndex((column) => column.field === active.id),
				columns.findIndex((column) => column.field === over.id),
			),
		);
	};
	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragEnd={move}
			accessibility={{
				screenReaderInstructions: { draggable: m.columns_drag_instructions() },
			}}
		>
			<SortableContext
				items={columns.map((column) => column.field)}
				strategy={verticalListSortingStrategy}
			>
				<ul className="flex flex-col gap-1.5">
					{columns.map((column) => (
						<VisibleRow
							key={column.field}
							column={column}
							removable={columns.length > 1}
							onRemove={() =>
								onChange(
									columns.filter((other) => other.field !== column.field),
								)
							}
							onRename={(label) =>
								onChange(
									columns.map((other) =>
										other.field === column.field
											? label
												? { field: other.field, label }
												: { field: other.field }
											: other,
									),
								)
							}
						/>
					))}
				</ul>
			</SortableContext>
		</DndContext>
	);
}
