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
	return `${format(lower)} – ${format(upper)}`;
}
