import { formatDate } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
	CheckIcon,
	CopyIcon,
	GlobeIcon,
	HouseIcon,
	LaptopIcon,
	SettingsIcon,
	TerminalIcon,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	formatCompactTime,
	formatExactTime,
	formatUnixTime,
	type TimeValue,
	timeDate,
	timeZoneAbbreviation,
} from "../lib/time-display";
import type { ProjectSummary } from "../organizations/contracts";
import { settingsSearch } from "./settings-links";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type TimeProject = Pick<
	ProjectSummary,
	"id" | "organizationId" | "name" | "timeZone"
>;
const TimeContext = createContext<{
	deviceTimeZone?: string;
	project?: TimeProject;
}>({});

export function TimeDisplayProvider({ children }: { children: ReactNode }) {
	const [deviceTimeZone, setDeviceTimeZone] = useState<string>();
	useEffect(() => {
		setDeviceTimeZone(
			Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		);
	}, []);
	const context = useMemo(() => ({ deviceTimeZone }), [deviceTimeZone]);
	return <TimeContext value={context}>{children}</TimeContext>;
}

export function ProjectTimeDisplayProvider({
	children,
	project,
}: {
	children: ReactNode;
	project?: TimeProject;
}) {
	const context = useContext(TimeContext);
	const scoped = useMemo(() => ({ ...context, project }), [context, project]);
	return <TimeContext value={scoped}>{children}</TimeContext>;
}

/** The zone times are shown in: the project's, else the device's once hydrated. */
export function useDisplayTimeZone() {
	const { deviceTimeZone, project } = useContext(TimeContext);
	return project?.timeZone ?? deviceTimeZone ?? "UTC";
}

type TimeDisplayProps = {
	value: TimeValue;
	mode?: "full" | "compact" | "relative";
	timeZone?: string;
	label?: string;
	unixNanoseconds?: string;
	className?: string;
};

export function TimeDisplay(props: TimeDisplayProps) {
	const { deviceTimeZone, project } = useContext(TimeContext);
	const date = timeDate(props.value);
	if (!Number.isFinite(date.getTime())) return <span>—</span>;
	return (
		<TimestampPopover
			key={`${date.getTime()}/${props.unixNanoseconds ?? ""}/${props.timeZone ?? ""}/${project?.id ?? ""}/${project?.timeZone ?? ""}/${deviceTimeZone ?? ""}/${getLocale()}`}
			{...props}
			value={date}
		/>
	);
}

function TimestampPopover({
	value,
	mode = "full",
	timeZone,
	label,
	unixNanoseconds,
	className,
}: TimeDisplayProps) {
	const { deviceTimeZone, project } = useContext(TimeContext);
	const locale = getLocale();
	const date = timeDate(value);
	const zone = timeZone ?? project?.timeZone ?? deviceTimeZone ?? "UTC";
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const titleId = useId();
	const reason = useRef<"hover" | "explicit">("explicit");
	const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const cancelTimers = () => {
		clearTimeout(openTimer.current);
		clearTimeout(closeTimer.current);
	};
	useEffect(
		() => () => {
			clearTimeout(openTimer.current);
			clearTimeout(closeTimer.current);
		},
		[],
	);
	const visible =
		label ??
		// A project zone is known during SSR, so compact times render there without a
		// full-date flash; only a page without a project waits for the device zone.
		(mode !== "full" && (deviceTimeZone || project?.timeZone)
			? formatCompactTime(date, mode === "relative", new Date(), locale, zone)
			: formatDate(date, locale, zone));
	const show = (next: boolean) => {
		cancelTimers();
		if (next) {
			setCopied(null);
			setFailed(false);
		}
		setOpen(next);
	};
	const leave = () => {
		clearTimeout(openTimer.current);
		if (reason.current === "hover")
			closeTimer.current = setTimeout(() => setOpen(false), 150);
	};
	const timedRow = (
		id: string,
		name: string,
		timeZone: string,
		icon: typeof LaptopIcon,
	) => ({
		id,
		name,
		zone: timeZone,
		abbreviation: timeZoneAbbreviation(date, locale, timeZone),
		value: formatExactTime(date, locale, timeZone),
		icon,
	});
	const rows = open
		? [
				timedRow(
					"device",
					m.time_your_device(),
					deviceTimeZone ?? "UTC",
					LaptopIcon,
				),
				...(project
					? [timedRow("project", m.project(), project.timeZone, HouseIcon)]
					: []),
				timedRow("utc", "UTC", "UTC", GlobeIcon),
				{
					id: "unix",
					name: "UNIX",
					zone: "",
					abbreviation: "",
					value: formatUnixTime(date, unixNanoseconds),
					icon: TerminalIcon,
				},
			]
		: [];
	return (
		<Popover open={open} onOpenChange={show}>
			<PopoverTrigger asChild>
				<button
					type="button"
					data-slot="time-display"
					disabled={!deviceTimeZone}
					className={cn(
						"inline-flex cursor-help rounded-sm text-inherit align-baseline whitespace-nowrap underline decoration-muted-foreground/40 decoration-dotted underline-offset-4 outline-none transition-colors hover:decoration-foreground/80 focus-visible:decoration-foreground/80 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
						className,
					)}
					aria-label={m.time_conversion_for({ value: visible })}
					onPointerDown={() => {
						reason.current = "explicit";
					}}
					onKeyDown={() => {
						reason.current = "explicit";
					}}
					onPointerEnter={(event) => {
						if (event.pointerType !== "mouse" || open || !deviceTimeZone)
							return;
						cancelTimers();
						openTimer.current = setTimeout(() => {
							reason.current = "hover";
							show(true);
						}, 200);
					}}
					onPointerLeave={leave}
				>
					{/* Relative text can differ by a tick between server and browser. */}
					<time dateTime={date.toISOString()} suppressHydrationWarning>
						{visible}
					</time>
				</button>
			</PopoverTrigger>
			{open && (
				<PopoverContent
					aria-labelledby={titleId}
					side="top"
					className="max-h-[var(--radix-popover-content-available-height)] w-[min(26rem,calc(100vw-1.5rem))] gap-0 overflow-y-auto p-0 text-xs"
					onOpenAutoFocus={(event) => {
						if (reason.current === "hover") event.preventDefault();
					}}
					onCloseAutoFocus={(event) => {
						if (reason.current === "hover") event.preventDefault();
					}}
					onPointerEnter={() => clearTimeout(closeTimer.current)}
					onPointerLeave={leave}
					onPointerDown={() => {
						reason.current = "explicit";
					}}
					onFocusCapture={() => {
						reason.current = "explicit";
					}}
				>
					<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
						<h3 id={titleId} className="text-sm font-semibold">
							{m.time_conversion()}
						</h3>
						{project && (
							<Button asChild variant="ghost" size="icon-xs">
								<Link
									to="/settings"
									search={settingsSearch("project-customization", {
										organizationId: project.organizationId,
										projectId: project.id,
									})}
									hash="project-time-zone"
									aria-label={m.time_project_settings()}
								>
									<SettingsIcon aria-hidden="true" />
								</Link>
							</Button>
						)}
					</div>
					<div className="flex flex-col gap-1.5 p-3">
						{rows.map((row) => (
							<div
								key={row.id}
								data-time-source={row.id}
								className="grid grid-cols-[1rem_minmax(0,1fr)_1.5rem] items-center gap-x-2 gap-y-0.5 sm:grid-cols-[1rem_minmax(0,1fr)_auto_1.5rem]"
							>
								<row.icon
									aria-hidden="true"
									className="size-3.5 text-muted-foreground"
								/>
								<div className="flex flex-wrap items-baseline gap-x-1.5">
									<span className="font-semibold">{row.name}</span>
									{row.id !== "utc" && row.abbreviation && (
										<span
											className="text-xs text-muted-foreground"
											title={row.zone}
										>
											{row.abbreviation}
										</span>
									)}
								</div>
								<span className="col-start-2 row-start-2 min-w-0 break-words text-muted-foreground tabular-nums sm:col-start-3 sm:row-start-1 sm:text-right sm:whitespace-nowrap">
									{row.value}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="col-start-3 row-start-1 sm:col-start-4"
									aria-label={m.time_copy({ source: row.name })}
									onClick={async () => {
										try {
											await navigator.clipboard.writeText(
												`${row.value}${row.abbreviation ? ` ${row.abbreviation}` : ""}`,
											);
											setCopied(row.id);
											setFailed(false);
										} catch {
											setFailed(true);
										}
									}}
								>
									{copied === row.id ? (
										<CheckIcon aria-hidden="true" className="size-3.5" />
									) : (
										<CopyIcon aria-hidden="true" className="size-3.5" />
									)}
								</Button>
							</div>
						))}
					</div>
					<p
						role="status"
						className={
							failed ? "px-3 pb-2 text-xs text-destructive" : "sr-only"
						}
					>
						{failed
							? m.settings_copy_failed()
							: copied
								? m.settings_copied()
								: ""}
					</p>
				</PopoverContent>
			)}
		</Popover>
	);
}

export function TimeDisplayRange({
	from,
	to,
	timeZone,
	recorded = false,
}: {
	from: Date;
	to: Date;
	timeZone: string;
	recorded?: boolean;
}) {
	return (
		<>
			{recorded && <>{m.recorded_interval_label()} </>}
			<TimeDisplay value={from} timeZone={timeZone} />
			{" – "}
			<TimeDisplay value={to} timeZone={timeZone} /> {timeZone}{" "}
			{recorded ? m.recorded_interval_notice() : m.interval_end_exclusive()}
		</>
	);
}
