import { toBlob } from "html-to-image";
import type { QueryResult } from "../contracts";
import type { SeriesView } from "../insight/series-view";

// A tile's result as a file or on the clipboard: its values as CSV, or the tile as
// it looks as a PNG.

function cell(value: string | number | null) {
	if (value === null) return "";
	const text = String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * One column per visible series and one row per bucket, with times in ISO 8601 UTC;
 * a table result has one row per series. Values are unformatted numbers.
 */
export function resultCsv(result: QueryResult, view: SeriesView) {
	const lines: (string | number | null)[][] = [];
	if (result.shape === "table") {
		lines.push(["series", "value"]);
		for (const series of view.visible)
			lines.push([view.label(series), series.points[0]?.value ?? null]);
	} else {
		lines.push(["time", ...view.visible.map((series) => view.label(series))]);
		const buckets = [
			...new Set(
				view.visible.flatMap((series) =>
					series.points.flatMap((point) =>
						point.bucketMs === null ? [] : [point.bucketMs],
					),
				),
			),
		].sort((a, b) => a - b);
		const values = view.visible.map(
			(series) =>
				new Map(series.points.map((point) => [point.bucketMs, point.value])),
		);
		for (const bucket of buckets)
			lines.push([
				new Date(bucket).toISOString(),
				...values.map((byBucket) => byBucket.get(bucket) ?? null),
			]);
	}
	return `${lines.map((line) => line.map(cell).join(",")).join("\n")}\n`;
}

/** The tile as a PNG at twice its size, on the card's own background. */
export async function tilePng(node: HTMLElement) {
	const blob = await toBlob(node, {
		pixelRatio: 2,
		backgroundColor: getComputedStyle(node).backgroundColor,
		// The menu and refresh buttons are not part of the picture.
		filter: (element) =>
			!(element instanceof HTMLElement && element.dataset.exportHidden),
	});
	if (!blob) throw new Error("The tile could not be drawn");
	return blob;
}

export function download(
	content: Blob | string,
	filename: string,
	type: string,
) {
	const url = URL.createObjectURL(
		content instanceof Blob ? content : new Blob([content], { type }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

/** A file name from an insight's name, without characters file systems reject. */
export function fileName(name: string, extension: string) {
	const base = name.replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim() || "insight";
	return `${base.slice(0, 100)}.${extension}`;
}
