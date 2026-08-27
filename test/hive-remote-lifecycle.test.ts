import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateRemoteLifecycle, isCurrentRemoteLifecycle, type RemoteTimer } from "../extensions/hive-remote/lifecycle.ts";

describe("hive-remote lifecycle", () => {
	afterEach(() => vi.useRealTimers());

	it("clears the extension timers and invalidates pending attachment work on reload", () => {
		vi.useFakeTimers();
		const flushTimer = setInterval(() => undefined, 1_000);
		const pollTimer = setInterval(() => undefined, 2_000);
		const titleTimer = setTimeout(() => undefined, 3_000);
		const lifecycle = {
			generation: 4,
			flushTimer: flushTimer as RemoteTimer,
			pollTimer: pollTimer as RemoteTimer,
			titleTimer,
		};

		invalidateRemoteLifecycle(lifecycle);

		expect(lifecycle).toEqual({ generation: 5, flushTimer: undefined, pollTimer: undefined, titleTimer: undefined });
		expect(isCurrentRemoteLifecycle(lifecycle, 4)).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps current attachment work valid until a lifecycle transition", () => {
		const lifecycle = { generation: 0 };

		expect(isCurrentRemoteLifecycle(lifecycle, 0)).toBe(true);
		invalidateRemoteLifecycle(lifecycle);
		expect(isCurrentRemoteLifecycle(lifecycle, 1)).toBe(true);
	});
});
