import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ exists: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: hooks.exists }));
vi.mock("node:child_process", () => ({ spawnSync: hooks.spawn }));

import kbNudge from "../extensions/kb-nudge.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

let pi: FakePi;
beforeEach(() => {
	vi.clearAllMocks();
	hooks.exists.mockReturnValue(true);
	hooks.spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({ additionalContext: "Search the KB." }) });
	pi = createFakePi();
	kbNudge(pi.api);
});

const prompt = { type: "before_agent_start", messageType: "user", prompt: "Upgrade the harness." };

describe("KB nudge with Pi 1.3 prompt and custom events", () => {
	it("ignores custom messages without consuming the one-shot prompt nudge", async () => {
		expect(await pi.emit({ type: "before_agent_start", messageType: "custom", message: { customType: "status", content: "Upgrade status" } })).toEqual([undefined]);
		expect(hooks.spawn).not.toHaveBeenCalled();
		const results = await pi.emit(prompt);
		expect(results).toMatchObject([{ message: { customType: "kb-nudge", content: "Search the KB." } }]);
		expect(JSON.parse(hooks.spawn.mock.calls[0][2].input)).toEqual({ prompt: prompt.prompt });
		await pi.emit(prompt);
		expect(hooks.spawn).toHaveBeenCalledTimes(1);
	});

	it("classifies prompt-bearing events without requiring a discriminator", async () => {
		expect(await pi.emit({ type: "before_agent_start", prompt: prompt.prompt })).toMatchObject([
			{ message: { customType: "kb-nudge" } },
		]);
		expect(hooks.spawn).toHaveBeenCalledTimes(1);
	});

	it("stays armed after a non-task prompt and rearms for a new session", async () => {
		hooks.spawn.mockReturnValueOnce({ status: 0, stdout: "{}" });
		expect(await pi.emit(prompt)).toEqual([undefined]);
		expect(await pi.emit(prompt)).toMatchObject([{ message: { customType: "kb-nudge" } }]);
		await pi.emit({ type: "session_start", reason: "new" });
		expect(await pi.emit(prompt)).toMatchObject([{ message: { customType: "kb-nudge" } }]);
		expect(hooks.spawn).toHaveBeenCalledTimes(3);
	});
});
