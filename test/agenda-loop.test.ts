/**
 * `/loop` — grammar, policy, tool activation and the tick.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runOneShot = vi.hoisted(() => vi.fn());
vi.mock("../extensions/agenda/spawn.ts", () => ({
	runOneShot,
	getPiInvocation: (args: string[]) => ({ command: "pi", args }),
}));

import agenda, { describeLoop, loadDefaultPrompt } from "../extensions/agenda/index.ts";
import {
	DEFAULT_LOOP_PROMPT,
	MAX_LOOP_FILE_BYTES,
	parseInterval,
	parseLoopCommand,
	truncateLoopFile,
} from "../extensions/agenda/loop-command.ts";
import { createLoopPolicy } from "../extensions/agenda/loop.ts";
import { createLoop, KEEPALIVE_MS, type LoopItem, MIN_DELAY_MS } from "../extensions/agenda/loop-state.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

let pi: FakePi;
beforeEach(() => {
	runOneShot.mockReset();
	pi = createFakePi();
});

describe("parseInterval", () => {
	it.each([
		["30s", 30_000],
		["5m", 300_000],
		["2h", 7_200_000],
		["1d", 86_400_000],
	])("%s → %i", (raw, expected) => {
		expect(parseInterval(raw)).toBe(expected);
	});

	it.each(["", "5", "m", "5x", "-5m", "0m", "abc"])("rejects %s", (raw) => {
		expect(parseInterval(raw)).toBeNull();
	});
});

describe("parseLoopCommand", () => {
	it("bare /loop uses the default prompt", () => {
		expect(parseLoopCommand("")).toEqual({ kind: "default" });
	});

	it.each(["stop", "off", "cancel"])("%s stops", (word) => {
		expect(parseLoopCommand(word)).toEqual({ kind: "stop" });
	});

	it("an interval plus a prompt is a fixed loop", () => {
		expect(parseLoopCommand("30m check the deploy")).toEqual({
			kind: "start",
			mode: "fixed",
			intervalMs: 1_800_000,
			prompt: "check the deploy",
			rounded: false,
		});
	});

	it("rounds a sub-minute interval UP rather than refusing it", () => {
		const parsed = parseLoopCommand("5s poll the queue");
		expect(parsed).toMatchObject({ intervalMs: MIN_DELAY_MS, rounded: true });
	});

	it("a bare prompt is a self-paced loop", () => {
		expect(parseLoopCommand("keep fixing the failing tests")).toEqual({
			kind: "start",
			mode: "self-paced",
			prompt: "keep fixing the failing tests",
		});
	});

	it("an interval with NO prompt is an error, not a prompt of '5m'", () => {
		expect(parseLoopCommand("5m")).toMatchObject({ kind: "error" });
	});

	it("does not mistake a leading number for an interval", () => {
		// "3 retries left…" is a prompt; only `<digits><unit>` is an interval.
		expect(parseLoopCommand("3 retries left before we give up")).toMatchObject({
			kind: "start",
			mode: "self-paced",
		});
	});

	it("refuses an interval longer than the loop's own lifetime", () => {
		expect(parseLoopCommand("30d do a thing")).toMatchObject({ kind: "error" });
	});
});

describe("truncateLoopFile", () => {
	it("passes a normal file through", () => {
		expect(truncateLoopFile("- do the thing")).toEqual({ text: "- do the thing", truncated: false });
	});

	it("truncates a huge one and says so IN the prompt, where the model will see it", () => {
		const { text, truncated } = truncateLoopFile("x".repeat(MAX_LOOP_FILE_BYTES + 100));
		expect(truncated).toBe(true);
		expect(text).toContain("was truncated");
	});
});

describe("loadDefaultPrompt", () => {
	it("prefers the project's .pi/loop.md", () => {
		const root = mkdtempSync(join(tmpdir(), "hive-pi-loopmd-"));
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "loop.md"), "- finish the migration");

		const { prompt, note } = loadDefaultPrompt(root);
		expect(prompt).toBe("- finish the migration");
		expect(note).toContain("loop.md");
	});

	it("falls back to the built-in maintenance prompt", () => {
		const empty = mkdtempSync(join(tmpdir(), "hive-pi-noloopmd-"));
		const { prompt } = loadDefaultPrompt(empty);
		expect(prompt).toBe(DEFAULT_LOOP_PROMPT);
	});

	it("ignores an empty loop.md rather than looping on nothing", () => {
		const root = mkdtempSync(join(tmpdir(), "hive-pi-emptyloopmd-"));
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "loop.md"), "   \n");
		expect(loadDefaultPrompt(root).prompt).toBe(DEFAULT_LOOP_PROMPT);
	});
});

describe("the built-in maintenance prompt", () => {
	it("bars new initiatives — the whole safety design for an unattended loop", () => {
		expect(DEFAULT_LOOP_PROMPT).toContain("Do NOT start new initiatives");
	});

	it("constrains irreversible actions to continuing prior authorization", () => {
		expect(DEFAULT_LOOP_PROMPT).toMatch(/already authorized/i);
	});

	it("tells the model to report a noop rather than invent work", () => {
		expect(DEFAULT_LOOP_PROMPT).toContain("noop:true");
	});
});

describe("the loop policy", () => {
	const context = { cwd: "/repo", ledger: { iterations: {} }, lastAssistantText: undefined, transcript: "" };

	function harnessFor(loop: LoopItem | null, now: number) {
		let current = loop;
		const injected: string[] = [];
		const policy = createLoopPolicy(
			{
				current: () => current,
				commit: (next) => {
					current = next;
				},
				beforeInject: () => injected.push("synced"),
			},
			() => now,
		);
		return { policy, injected, get current() { return current; } };
	}

	const T0 = 1_700_000_000_000;

	it("declines while nothing is due", () => {
		const loop = createLoop("l", "fixed", "p", T0, { intervalMs: 300_000 });
		expect(harnessFor(loop, T0 + 1).policy.decide(context)).toBeNull();
	});

	it("injects the prompt verbatim when due", async () => {
		const loop = createLoop("l", "fixed", "check the deploy", T0, { intervalMs: 300_000 });
		const harness = harnessFor(loop, T0 + 300_000);

		const outcome = await harness.policy.decide(context)!.run();
		expect(outcome.inject).toBe("check the deploy");
		expect(harness.current?.fires).toBe(1);
	});

	it("re-asserts the tool set immediately before injecting", async () => {
		// Injected turns never emit before_agent_start, so this is the only hook
		// that runs on the path the loop actually takes.
		const loop = createLoop("l", "self-paced", "go", T0);
		const due = { ...loop, nextAt: T0 };
		const harness = harnessFor(due, T0);

		await harness.policy.decide(context)!.run();
		expect(harness.injected).toEqual(["synced"]);
	});

	it("ends a self-paced loop when its keepalive lapses, injecting nothing", async () => {
		const loop = createLoop("l", "self-paced", "go", T0);
		const lapsing = { ...loop, nextAt: T0 + KEEPALIVE_MS, keepaliveArmed: true };
		const harness = harnessFor(lapsing, T0 + KEEPALIVE_MS);

		const outcome = await harness.policy.decide(context)!.run();
		expect(outcome.inject).toBeUndefined();
		expect(harness.current?.state).toBe("dry");
	});

	it("stops an EXPIRED loop on the next settle, without waiting for its next fire", async () => {
		// A 7-day-expired hourly loop would otherwise linger until an hour passed.
		const loop = createLoop("l", "fixed", "p", T0, { intervalMs: 3_600_000 });
		const harness = harnessFor(loop, loop.expiresAt + 1);

		const outcome = await harness.policy.decide(context)!.run();
		expect(outcome.inject).toBeUndefined();
		expect(harness.current?.state).toBe("expired");
	});

	it("declines once the loop is terminal", () => {
		const loop = { ...createLoop("l", "fixed", "p", T0), state: "stopped" as const };
		expect(harnessFor(loop, T0 + 999_999).policy.decide(context)).toBeNull();
	});
});

describe("/loop command", () => {
	it("registers alongside /goal and /agenda", () => {
		agenda(pi.api);
		expect(pi.commands.has("loop")).toBe(true);
	});

	it("starting a loop persists it and delivers the first iteration immediately", async () => {
		agenda(pi.api);
		await pi.runCommand("loop", "30m check the deploy");

		expect(pi.entries).toHaveLength(1);
		expect(pi.messages).toHaveLength(1);
		expect(pi.messages[0].content).toBe("check the deploy");
		expect(pi.messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	it("reports the rounding when a sub-minute interval is asked for", async () => {
		agenda(pi.api);
		await pi.runCommand("loop", "5s poll");
		expect(pi.notifications.at(-1)?.message).toContain("rounded up");
	});

	it("stop is idempotent and says so when nothing is running", async () => {
		agenda(pi.api);
		await pi.runCommand("loop", "stop");
		expect(pi.notifications.at(-1)?.message).toBe("No loop is running.");
	});

	it("stop ends a running loop", async () => {
		agenda(pi.api);
		await pi.runCommand("loop", "30m go");
		await pi.runCommand("loop", "stop");
		expect((pi.entries.at(-1)?.data as LoopItem).state).toBe("stopped");
	});

	it("/agenda stop is a panic button that stops the loop too", async () => {
		agenda(pi.api);
		await pi.runCommand("loop", "30m go");
		await pi.runCommand("agenda", "stop");
		expect((pi.entries.at(-1)?.data as LoopItem).state).toBe("stopped");
	});
});

describe("agenda_wake tool activation", () => {
	it("is registered, but pi force-activates it — so session_start must remove it", async () => {
		agenda(pi.api);
		// pi activates every registered extension tool at session build.
		expect(pi.activeTools).toContain("agenda_wake");

		await pi.emit({ type: "session_start", reason: "startup" });
		expect(pi.activeTools).not.toContain("agenda_wake");
	});

	it("is removed again on RELOAD, which re-activates everything", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		// Simulate pi's reload re-activation.
		pi.api.setActiveTools([...pi.activeTools, "agenda_wake"]);
		await pi.emit({ type: "session_start", reason: "reload" });
		expect(pi.activeTools).not.toContain("agenda_wake");
	});

	it("becomes active only for a SELF-PACED loop", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });

		await pi.runCommand("loop", "keep going until the tests pass");
		expect(pi.activeTools).toContain("agenda_wake");
	});

	it("stays inactive for a FIXED loop, which re-arms itself", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });

		await pi.runCommand("loop", "30m check the deploy");
		expect(pi.activeTools).not.toContain("agenda_wake");
	});

	it("is removed again when the loop stops", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await pi.runCommand("loop", "keep going");
		await pi.runCommand("loop", "stop");
		expect(pi.activeTools).not.toContain("agenda_wake");
	});

	it("read-modify-writes the LIVE set, so it composes with plan-mode's wholesale replacement", async () => {
		agenda(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		pi.api.setActiveTools(["read", "grep"]); // another extension replaced everything

		await pi.runCommand("loop", "keep going");
		expect(pi.activeTools).toEqual(expect.arrayContaining(["read", "grep", "agenda_wake"]));
	});
});

describe("describeLoop", () => {
	const T0 = 1_700_000_000_000;

	it("says so when nothing runs", () => {
		expect(describeLoop(null, T0)).toBe("No loop is running.");
	});

	it("shows the next fire", () => {
		const loop = createLoop("l", "fixed", "p", T0, { intervalMs: 300_000 });
		expect(describeLoop(loop, T0)).toContain("next: in 5m");
	});

	it("names the keepalive so a quiet loop is not mistaken for a healthy one", () => {
		const loop = { ...createLoop("l", "self-paced", "p", T0), nextAt: T0 + 60_000, keepaliveArmed: true };
		expect(describeLoop(loop, T0)).toContain("keepalive");
	});

	it("distinguishes a dry loop from a stopped one", () => {
		const dry = { ...createLoop("l", "self-paced", "p", T0), state: "dry" as const };
		expect(describeLoop(dry, T0)).toContain("stopped re-arming");
	});

	it("reports a noop run", () => {
		const quiet = { ...createLoop("l", "self-paced", "p", T0), noopStreak: 2 };
		expect(describeLoop(quiet, T0)).toContain("nothing to report");
	});
});
