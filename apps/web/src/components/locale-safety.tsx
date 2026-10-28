import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useState,
} from "react";

const LocaleSafetyContext = createContext({
	blocked: false,
	register: (_id: string, _blocked: boolean) => {},
});

export function LocaleSafety({ children }: { children: ReactNode }) {
	const [blockers, setBlockers] = useState<ReadonlySet<string>>(new Set());
	const register = useCallback((id: string, blocked: boolean) => {
		setBlockers((previous) => {
			if (previous.has(id) === blocked) return previous;
			const next = new Set(previous);
			if (blocked) next.add(id);
			else next.delete(id);
			return next;
		});
	}, []);
	return (
		<LocaleSafetyContext value={{ blocked: blockers.size > 0, register }}>
			{children}
		</LocaleSafetyContext>
	);
}

export function useLocaleChangeBlocker(blocked: boolean) {
	const { register } = useContext(LocaleSafetyContext);
	const id = useId();
	useEffect(() => {
		register(id, blocked);
		return () => register(id, false);
	}, [register, id, blocked]);
}

export function useLocaleChangeBlocked() {
	return useContext(LocaleSafetyContext).blocked;
}
