import { useCallback, useState } from "react";

export interface Progress {
	loading: ReadonlySet<string>;
	/** Tiles that have loaded or are loading since the others last all finished. */
	total: number;
}

/** The progress after a tile starts or stops loading. */
export function nextProgress(
	current: Progress,
	id: string,
	fetching: boolean,
): Progress {
	const had = current.loading.has(id);
	if (fetching === had) return current;
	const loading = new Set(current.loading);
	if (fetching) {
		loading.add(id);
		return { loading, total: current.loading.size ? current.total + 1 : 1 };
	}
	loading.delete(id);
	return { loading, total: loading.size ? current.total : 0 };
}

/**
 * How far the tiles loading together have got. A batch starts when a tile begins
 * loading while none are, grows as more begin, and ends when all have finished.
 */
export function useLoadProgress() {
	const [progress, setProgress] = useState<Progress>({
		loading: new Set(),
		total: 0,
	});
	const report = useCallback(
		(id: string, fetching: boolean) =>
			setProgress((current) => nextProgress(current, id, fetching)),
		[],
	);
	const loading = progress.loading.size;
	return {
		/** Null when nothing is loading. */
		progress: loading
			? { done: progress.total - loading, total: progress.total }
			: null,
		report,
	};
}
