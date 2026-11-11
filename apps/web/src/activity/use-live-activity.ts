import { useEffect, useState } from "react";
import { MutationFailure } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import type { LiveEvent } from "./contracts";
import { emptyLive, liveSnapshot, parseLiveEvent } from "./live-state";

export function useLiveActivity(
	reference: ProjectReference,
	enabled: boolean,
	generation: number,
) {
	const [state, setState] = useState(() => ({
		data: emptyLive(),
		error: null as Error | null,
	}));
	useEffect(() => {
		if (!enabled) return;
		// Reload deliberately opens a new connection rather than replaying old events.
		void generation;
		let events: LiveEvent[] = [],
			startedAt = new Date(),
			received = 0,
			// Arrival times of every packet in the last minute, including ones not retained.
			arrivals: number[] = [];
		let connected = false,
			disposed = false;
		let rendered = 0,
			timer: ReturnType<typeof setTimeout> | undefined;
		const source = new EventSource(
			`/api/activity/live?${new URLSearchParams({ organizationId: reference.organizationId, projectId: reference.projectId })}`,
		);
		setState({ data: emptyLive(startedAt), error: null });
		const render = () => {
			timer = undefined;
			if (disposed || !connected) return;
			rendered = Date.now();
			events = events.filter(
				(e) => e.summary.receivedAt.getTime() >= Date.now() - 300000,
			);
			arrivals = arrivals.filter((time) => time > Date.now() - 60000);
			setState({
				data: liveSnapshot(events, startedAt, new Date(), received, arrivals),
				error: null,
			});
		};
		// Busy fleets can send hundreds of packets per second; render at most once a second.
		const update = () => {
			if (timer) return;
			timer = setTimeout(render, Math.max(0, rendered + 1000 - Date.now()));
		};
		source.addEventListener("connected", () => {
			if (disposed) return;
			events = [];
			startedAt = new Date();
			received = 0;
			arrivals = [];
			connected = true;
			render();
		});
		source.addEventListener("packet", (message) => {
			if (disposed) return;
			try {
				const event = parseLiveEvent(message.data, reference.projectId);
				events = [
					event,
					...events.filter((e) => e.summary.id !== event.summary.id),
				].slice(0, 100);
				received++;
				arrivals.push(Date.now());
				update();
			} catch {
				source.close();
				connected = false;
				setState((s) => ({ ...s, error: new Error("Invalid Live event") }));
			}
		});
		source.addEventListener("heartbeat", update);
		source.addEventListener("unavailable", () => {
			if (disposed) return;
			connected = false;
			setState((s) => ({
				data: { ...s.data, status: "disconnected" },
				error: new Error("Live unavailable"),
			}));
		});
		source.addEventListener("failure", (message) => {
			if (disposed) return;
			connected = false;
			const code = JSON.parse(message.data).code;
			const denied = [
				"UNAUTHENTICATED",
				"SESSION_NOT_FRESH",
				"FORBIDDEN",
				"NOT_FOUND",
			].includes(code);
			if (denied) source.close();
			setState((s) => ({
				data: denied ? emptyLive() : { ...s.data, status: "disconnected" },
				error: denied
					? new MutationFailure({ code, message: code })
					: new Error("Live unavailable"),
			}));
		});
		source.onerror = () => {
			if (disposed) return;
			connected = false;
			setState((s) => ({ ...s, data: { ...s.data, status: "disconnected" } }));
		};
		return () => {
			disposed = true;
			clearTimeout(timer);
			source.close();
			events = [];
		};
	}, [reference.organizationId, reference.projectId, enabled, generation]);
	return {
		...state,
		isError: state.error !== null,
		isPending: false,
		isFetching: false,
	};
}
