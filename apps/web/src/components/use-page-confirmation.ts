import { useLocation } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useMutationBoundary } from "./mutation-feedback";

export function usePageConfirmation<T>() {
	const locationKey = useLocation({
		select: (location) => location.state.__TSR_key,
	});
	const capture = useMutationBoundary();
	const [confirmation, setConfirmation] = useState<{
		value: T;
		locationKey: typeof locationKey;
		signal: AbortSignal;
	} | null>(null);
	if (confirmation && confirmation.locationKey !== locationKey)
		setConfirmation(null);
	const confirm = useCallback(
		(value: T | null) => {
			const signal = capture();
			setConfirmation(
				value !== null && signal ? { value, locationKey, signal } : null,
			);
		},
		[capture, locationKey],
	);
	return [
		confirmation &&
		confirmation.locationKey === locationKey &&
		!confirmation.signal.aborted
			? confirmation.value
			: null,
		confirm,
	] as const;
}
