import { getLocale, type Locale } from "@recount/i18n/runtime";

export function formatSessionTime(
	value: Date | string,
	relative = false,
	now = new Date(),
	locale: Locale = getLocale(),
) {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return "—";
	const elapsed = now.getTime() - date.getTime();
	const distance = Math.abs(elapsed);
	const relativeFormat = new Intl.RelativeTimeFormat(locale, {
		numeric: "auto",
	});
	if (relative && distance < 60_000) return relativeFormat.format(0, "second");
	if (relative && distance < 3_600_000)
		return relativeFormat.format(-Math.trunc(elapsed / 60_000), "minute");
	if (relative && distance < 86_400_000)
		return relativeFormat.format(-Math.trunc(elapsed / 3_600_000), "hour");
	const day = new Date(date).setHours(0, 0, 0, 0);
	const today = new Date(now).setHours(0, 0, 0, 0);
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	yesterday.setHours(0, 0, 0, 0);
	const time = new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
	if (day === today || day === yesterday.getTime())
		return `${relativeFormat.format(day === today ? 0 : -1, "day")}, ${time}`;
	return new Intl.DateTimeFormat(locale, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

export function SessionTime({
	value,
	relative = false,
}: {
	value: Date | string;
	relative?: boolean;
}) {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return <span>—</span>;
	return (
		<time
			dateTime={date.toISOString()}
			title={date.toLocaleString(getLocale())}
			className="whitespace-nowrap"
		>
			{formatSessionTime(value, relative)}
		</time>
	);
}
