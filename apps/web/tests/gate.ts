export function gate<T = void>() {
	let release!: (value: T) => void;
	return {
		promise: new Promise<T>((resolve) => {
			release = resolve;
		}),
		release: (value: T) => release(value),
	};
}
