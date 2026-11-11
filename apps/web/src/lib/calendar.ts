export function decodeCalendarTimestamp(value: unknown) {
	const match =
		typeof value === "string" &&
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
			value,
		);
	if (!match) return { error: "syntax" } as const;
	const [year, month, day, hour, minute, second] = match
		.slice(1, 7)
		.map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	const time = Date.parse(match[0]);
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > days[month - 1] ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		!Number.isFinite(time)
	)
		return { error: "calendar" } as const;
	return { error: null, year, time } as const;
}
