/** Controllable gates without depending on an ES2024 TypeScript library. */
export function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(settle => { resolve = settle; });
	return { promise, resolve };
}
