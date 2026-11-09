export function oneCreateRetry<Input>(input: Input, current: () => boolean) {
	let state: "available" | "consumed" = "available";
	return () => {
		if (state === "consumed" || !current()) return null;
		state = "consumed";
		return { input };
	};
}
