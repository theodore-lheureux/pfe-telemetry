import { expect, test } from "bun:test";
import {
	nextProgress,
	type Progress,
} from "../../src/analytics/dashboards/use-load-progress";

test("a load counts only the tiles that joined it, and ends when all finish", () => {
	let progress: Progress = { loading: new Set(), total: 0 };
	const report = (id: string, fetching: boolean) => {
		progress = nextProgress(progress, id, fetching);
	};
	report("a", true);
	report("b", true);
	expect(progress).toMatchObject({ total: 2 });
	report("a", false);
	// A tile starting before the others finish joins the same load.
	report("c", true);
	expect(progress.total - progress.loading.size).toBe(1);
	expect(progress.total).toBe(3);
	report("b", false);
	report("c", false);
	expect(progress).toMatchObject({ total: 0 });
	// The next load starts from its own tiles, not the dashboard's.
	report("b", true);
	expect(progress.total).toBe(1);
});
