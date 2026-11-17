import {
	DndContext,
	KeyboardSensor,
	type Modifier,
	PointerSensor,
	useDraggable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { m } from "@recount/i18n/messages";
import { GripVerticalIcon } from "lucide-react";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useEffect,
	useState,
} from "react";
import { Button } from "../components/ui/button";
import { SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { cn } from "../lib/utils";

export type PanelPosition = { x: number; y: number } | null;
type PositionSetter = Dispatch<SetStateAction<PanelPosition>>;
const margin = 12;

const withinViewport: Modifier = ({
	transform,
	draggingNodeRect,
	windowRect,
}) => {
	if (!draggingNodeRect || !windowRect) return transform;
	return {
		...transform,
		x: Math.max(
			margin - draggingNodeRect.left,
			Math.min(transform.x, windowRect.width - margin - draggingNodeRect.right),
		),
		y: Math.max(
			margin - draggingNodeRect.top,
			Math.min(
				transform.y,
				windowRect.height - margin - draggingNodeRect.bottom,
			),
		),
	};
};

export function FloatingToolbarPanel({
	children,
	position,
	setPosition,
	wide = false,
}: {
	children: ReactNode;
	position: PanelPosition;
	setPosition: PositionSetter;
	wide?: boolean;
}) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor),
	);
	return (
		<DndContext
			sensors={sensors}
			modifiers={[withinViewport]}
			autoScroll={false}
			accessibility={{
				screenReaderInstructions: { draggable: m.developer_drag_instruction() },
				announcements: {
					onDragStart: () => m.developer_drag_start(),
					onDragEnd: () => m.developer_drag_end(),
					onDragCancel: () => m.developer_drag_cancelled(),
					onDragMove: () => undefined,
					onDragOver: () => undefined,
				},
			}}
			onDragEnd={({ active }) => {
				const rect = active.rect.current.translated;
				if (rect) setPosition({ x: rect.left, y: rect.top });
			}}
		>
			<PanelContent position={position} setPosition={setPosition} wide={wide}>
				{children}
			</PanelContent>
		</DndContext>
	);
}

function PanelContent({
	children,
	position,
	setPosition,
	wide,
}: {
	children: ReactNode;
	position: PanelPosition;
	setPosition: PositionSetter;
	wide: boolean;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		isDragging,
	} = useDraggable({
		id: "recount-developer-toolbar",
		attributes: { roleDescription: m.developer_drag_role() },
	});
	const [panel, setPanel] = useState<HTMLDivElement | null>(null);
	const ref = useCallback(
		(node: HTMLDivElement | null) => {
			setPanel(node);
			setNodeRef(node);
		},
		[setNodeRef],
	);
	useEffect(() => {
		const node = panel;
		if (!node) return;
		const constrain = () =>
			setPosition((current) => {
				if (!current) return current;
				const x = Math.max(
					margin,
					Math.min(current.x, window.innerWidth - node.offsetWidth - margin),
				);
				const y = Math.max(
					margin,
					Math.min(current.y, window.innerHeight - node.offsetHeight - margin),
				);
				return x === current.x && y === current.y ? current : { x, y };
			});
		const observer = new ResizeObserver(constrain);
		observer.observe(node);
		window.addEventListener("resize", constrain);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", constrain);
		};
	}, [panel, setPosition]);
	return (
		<SheetContent
			ref={ref}
			aria-describedby={undefined}
			onInteractOutside={(event) => event.preventDefault()}
			onEscapeKeyDown={(event) => {
				if (isDragging) event.preventDefault();
			}}
			style={{
				left: position?.x,
				top: position?.y,
				right: position ? "auto" : undefined,
				bottom: position ? "auto" : undefined,
				transform: transform
					? `translate3d(${transform.x}px, ${transform.y}px, 0)`
					: undefined,
			}}
			className={cn(
				"gap-0 overflow-hidden rounded-lg border shadow-xl transition-none data-open:animate-none data-closed:animate-none data-[side=right]:inset-y-auto data-[side=right]:right-3 data-[side=right]:bottom-3 data-[side=right]:h-auto data-[side=right]:max-h-[calc(100dvh-1.5rem)] data-[side=right]:w-[calc(100vw-1.5rem)] data-[side=right]:sm:max-w-[420px]",
				wide && "data-[side=right]:md:max-w-[920px]",
			)}
		>
			<SheetHeader className="shrink-0 border-b p-2 pr-12">
				<Button
					ref={setActivatorNodeRef}
					variant="ghost"
					className="w-full touch-none cursor-grab justify-start gap-2 px-1.5 active:cursor-grabbing"
					aria-label={m.developer_move_toolbar()}
					title={m.developer_move_toolbar()}
					{...attributes}
					{...listeners}
				>
					<GripVerticalIcon
						className="size-4 text-muted-foreground"
						aria-hidden="true"
					/>
					<SheetTitle asChild className="text-sm">
						<span>{m.developer_toolbar()}</span>
					</SheetTitle>
				</Button>
			</SheetHeader>
			{children}
		</SheetContent>
	);
}
