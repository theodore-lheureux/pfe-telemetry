import { getLocale } from "@recount/i18n/runtime";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { useMemo } from "react";
import { useDisplayTimeZone } from "../../components/time-display";
import { MutationFailure, unwrapOperation } from "../../lib/operation-result";
import type { taskQueue } from "../../lib/task-queue";
import type { ProjectReference } from "../../organizations/contracts";
import { runAnalyticsQuery } from "../analytics.functions";
import type { QueryResult } from "../contracts";
import { type InsightDraft, toQuery } from "../insight/draft";

/** Attempts per tile when analytics is busy, the first one included. */
const BUSY_ATTEMPTS = 4;

function busy(error: unknown) {
	return error instanceof MutationFailure && error.failure.code === "CAPACITY";
}

/**
 * One tile's result. Tiles start through the dashboard's queue, so only a few read at
 * once, and retry with growing, jittered delays while analytics is busy.
 */
export function useTileQuery({
	userId,
	reference,
	draft,
	now,
	queue,
}: {
	userId: string;
	reference: ProjectReference;
	draft: InsightDraft;
	/** What relative ranges resolve against; a newer time refreshes the tile. */
	now: Date;
	queue: ReturnType<typeof taskQueue>;
}) {
	const hydrated = useHydrated();
	const locale = getLocale(),
		zone = useDisplayTimeZone();
	const query = useMemo(
		() => toQuery(draft, now, zone, locale),
		[draft, now, zone, locale],
	);
	const result = useQuery<QueryResult>({
		queryKey: ["analytics-query", userId, reference.projectId, query],
		queryFn: ({ signal }) =>
			queue(
				async () =>
					unwrapOperation(
						await runAnalyticsQuery({
							data: { ...reference, query: query as NonNullable<typeof query> },
							signal,
						}),
					),
				signal,
			),
		enabled: hydrated && query !== null,
		placeholderData: keepPreviousData,
		retry: (failures, error) => failures < BUSY_ATTEMPTS - 1 && busy(error),
		retryDelay: (attempt) =>
			Math.min(1000 * 1.5 ** attempt, 8000) * (0.75 + Math.random() * 0.5),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	return { query, result };
}
