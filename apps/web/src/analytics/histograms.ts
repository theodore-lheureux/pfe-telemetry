/** The values histogram bucket `index` holds; one more bucket than bounds holds the rest. */
export function bucketRange(
	bounds: number[],
	index: number,
	format: (value: number) => string,
) {
	const lower = bounds[index - 1],
		upper = bounds[index];
	if (upper === undefined)
		return lower === undefined ? "" : `> ${format(lower)}`;
	if (lower === undefined) return `≤ ${format(upper)}`;
	// Ends that share a unit show it once: "1–5 %", "1–2 MiB".
	const [low, high] = [format(lower), format(upper)].map((text) =>
		/^(.*\d)(\D*)$/.exec(text),
	);
	if (low && high && low[2] === high[2]) return `${low[1]}–${high[0]}`;
	return `${format(lower)}–${format(upper)}`;
}
