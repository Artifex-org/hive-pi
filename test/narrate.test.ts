import { describe, expect, it, vi } from "vitest";
import { createFakePi } from "./fake-pi.ts";
import narrateExtension from "../extensions/narrate/index.ts";
import {
	SILENT_TOOL_CALLS,
	SLOW_WAIT_MS,
	createNarration,
	noteAssistantMessage,
	noteReminded,
	noteUserTurn,
	remindReason,
	reminderText,
	shouldRemind,
	slowWaitText,
} from "../extensions/narrate/narrate.ts";

// The nudge has to fire on the failure mode and stay silent on competent work.
// Both halves matter: a reminder that also fires on a normal three-call burst is
// one the model learns to skip, which costs the reminder its effect on the case
// it exists for.

describe("silent streak", () => {
	it("fires once the agent has gone quiet for a stretch", () => {
		const s = createNarration();
		noteAssistantMessage(s, false, 3);
		expect(shouldRemind(s)).toBe(false);
		noteAssistantMessage(s, false, 2);
		expect(shouldRemind(s)).toBe(true);
	});

	it("stays quiet through a normal short burst", () => {
		const s = createNarration();
		noteAssistantMessage(s, false, 3);
		expect(shouldRemind(s)).toBe(false);
	});

	// The agent DID what was asked. Counting the calls it narrated as silent
	// would nag it for complying — and a message carrying prose alongside its
	// tool calls is precisely the target behaviour.
	it("treats prose alongside tool calls as narration", () => {
		const s = createNarration();
		noteAssistantMessage(s, false, 4);
		noteAssistantMessage(s, true, 6);
		expect(s.silentToolCalls).toBe(0);
		expect(shouldRemind(s)).toBe(false);
	});

	it("counts from zero again after the agent speaks", () => {
		const s = createNarration();
		noteAssistantMessage(s, false, 9);
		noteAssistantMessage(s, true, 0);
		noteAssistantMessage(s, false, 2);
		expect(shouldRemind(s)).toBe(false);
	});

	// A fresh instruction starts from silence.
	it("clears the streak on a new user turn", () => {
		const s = createNarration();
		noteAssistantMessage(s, false, 20);
		noteUserTurn(s);
		expect(shouldRemind(s)).toBe(false);
	});
});

describe("once per streak", () => {
	// THE ONE THAT KEEPS THE COST DOWN. `tool_result` fires after EVERY tool, so
	// a reminder that re-armed itself would ride on every result for the rest of
	// the streak — appended text on each one, permanently in history, and a nag
	// the model would start ignoring.
	it("does not fire again while the agent is still silent", () => {
		const s = createNarration();
		noteAssistantMessage(s, false, 6);
		expect(shouldRemind(s)).toBe(true);
		noteReminded(s);

		for (let i = 0; i < 20; i++) {
			noteAssistantMessage(s, false, 3);
			expect(shouldRemind(s)).toBe(false);
		}
	});

	// ...but a second stretch of silence after the agent spoke is a NEW failure,
	// and gets its own nudge.
	it("re-arms once the agent speaks", () => {
		const s = createNarration();
		noteAssistantMessage(s, false, 6);
		noteReminded(s);
		noteAssistantMessage(s, true, 0);
		noteAssistantMessage(s, false, 6);
		expect(shouldRemind(s)).toBe(true);
	});

	it("re-arms on a new user turn too", () => {
		const s = createNarration();
		noteAssistantMessage(s, false, 6);
		noteReminded(s);
		noteUserTurn(s);
		noteAssistantMessage(s, false, 6);
		expect(shouldRemind(s)).toBe(true);
	});
});

describe("threshold", () => {
	it("matches the ceiling AGENTS.md states, so the two teach one rule", () => {
		expect(SILENT_TOOL_CALLS).toBe(5);
	});

	it("honours a configured threshold", () => {
		const s = createNarration();
		noteAssistantMessage(s, false, 8);
		expect(shouldRemind(s, 12)).toBe(false);
		noteAssistantMessage(s, false, 4);
		expect(shouldRemind(s, 12)).toBe(true);
	});
});

describe("reminderText", () => {
	it("states the checkable fact and asks for one line", () => {
		const text = reminderText(7);
		expect(text).toContain("7 tool calls");
		expect(text).toContain("ONE short line");
		// Wrapped so a model that has learned the convention reads it as harness
		// machinery rather than as the operator suddenly interrupting.
		expect(text.startsWith("<system-reminder>")).toBe(true);
		expect(text.endsWith("</system-reminder>")).toBe(true);
	});

	// It is a status line, not a deliverable. Asking for a report mid-task is how
	// a nudge turns into a derailment.
	it("is short enough to be a nudge", () => {
		expect(reminderText(9).length).toBeLessThan(400);
	});
});

/**
 * The second trigger: a long SILENT WAIT.
 *
 * The streak trigger answers "many calls, nobody told". This answers the other
 * half of the same complaint — one call, nothing on screen, and a person
 * watching who cannot tell a slow command from a hung one. It exists because
 * `background_*` made "do not block on it at all" a real option, and a reminder
 * that arrives while the wait is happening is the only place the harness can
 * teach the habit before the next one.
 *
 * Costing nothing extra is the design constraint: pi gives `tool_result` no
 * duration, and `tool_execution_start`/`_end` would be two more handlers on a
 * deliberately small hooks budget. `message_end` already says when the batch
 * was dispatched and `tool_result` already says when one came back.
 */
describe("the slow-wait trigger", () => {
	it("fires when a silent batch has been running past the threshold", () => {
		const state = createNarration();
		noteAssistantMessage(state, false, 1, 1_000);
		expect(remindReason(state, SILENT_TOOL_CALLS, 1_000 + SLOW_WAIT_MS)).toBe("slow-wait");
	});

	it("stays quiet for a fast batch", () => {
		const state = createNarration();
		noteAssistantMessage(state, false, 1, 1_000);
		expect(remindReason(state, SILENT_TOOL_CALLS, 1_500)).toBeNull();
	});

	it("never fires when the agent SAID what it was doing, however long the wait", () => {
		// This is the whole point: waiting is fine, waiting unexplained is not.
		// A model that complied must not then be nagged for the wait it announced.
		const state = createNarration();
		noteAssistantMessage(state, true, 1, 1_000);
		expect(remindReason(state, SILENT_TOOL_CALLS, 1_000 + SLOW_WAIT_MS * 10)).toBeNull();
	});

	it("does not start a clock for a message that dispatched no tools", () => {
		// A silent message with no tool calls ends the turn. There is nothing to
		// wait for, and treating it as a wait would fire on an idle session.
		const state = createNarration();
		noteAssistantMessage(state, false, 0, 1_000);
		expect(remindReason(state, SILENT_TOOL_CALLS, 1_000 + SLOW_WAIT_MS * 10)).toBeNull();
	});

	it("prefers the streak when both apply — it is the larger complaint", () => {
		const state = createNarration();
		for (let i = 0; i < SILENT_TOOL_CALLS; i += 1) noteAssistantMessage(state, false, 1, 1_000);
		expect(remindReason(state, SILENT_TOOL_CALLS, 1_000 + SLOW_WAIT_MS)).toBe("streak");
	});

	it("reports one wait once, not once per result in the batch", () => {
		const state = createNarration();
		noteAssistantMessage(state, false, 3, 1_000);
		const late = 1_000 + SLOW_WAIT_MS;
		expect(remindReason(state, SILENT_TOOL_CALLS, late)).toBe("slow-wait");
		noteReminded(state);
		expect(remindReason(state, SILENT_TOOL_CALLS, late + 5_000)).toBeNull();
	});

	it("re-arms once the agent speaks", () => {
		const state = createNarration();
		noteAssistantMessage(state, false, 1, 1_000);
		noteReminded(state);
		noteAssistantMessage(state, true, 0, 2_000);
		noteAssistantMessage(state, false, 1, 3_000);
		expect(remindReason(state, SILENT_TOOL_CALLS, 3_000 + SLOW_WAIT_MS)).toBe("slow-wait");
	});

	it("a new user turn clears a pending wait", () => {
		const state = createNarration();
		noteAssistantMessage(state, false, 1, 1_000);
		noteUserTurn(state);
		expect(remindReason(state, SILENT_TOOL_CALLS, 1_000 + SLOW_WAIT_MS)).toBeNull();
	});

	it("names both remedies: say it, or stop blocking on it", () => {
		const text = slowWaitText(45_000);
		expect(text).toContain("45s");
		expect(text).toContain("background_bash");
		// And it is NOT the streak text — the two complaints are different.
		expect(text).not.toContain("without saying anything");
	});
});

/**
 * The extension, running.
 *
 * The fold above can be entirely correct while the handler ignores it — the
 * failure this repo has shipped before (handlers registered behind an early
 * return, a trigger computed and then not used). What is asserted here is that
 * a real `tool_result` comes back carrying the reminder, appended after the
 * tool's own content rather than spliced into it.
 */
describe("the extension delivers the slow-wait reminder", () => {
	it("appends it to a tool result after a long silent batch", async () => {
		const now = vi.spyOn(Date, "now");
		try {
			const pi = createFakePi();
			narrateExtension(pi.api);

			now.mockReturnValue(1_000);
			await pi.emit({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "toolCall" }] },
			});

			now.mockReturnValue(1_000 + SLOW_WAIT_MS + 5_000);
			const handlers = pi.handlers.get("tool_result") ?? [];
			expect(handlers).toHaveLength(1);
			const result = (await handlers[0](
				{ type: "tool_result", content: [{ type: "text", text: "the tool output" }] },
				{} as never,
			)) as { content?: { text?: string }[] } | undefined;

			expect(result?.content).toHaveLength(2);
			// The tool's own output is untouched and comes FIRST.
			expect(result?.content?.[0]?.text).toBe("the tool output");
			expect(result?.content?.[1]?.text).toContain("background_bash");
			expect(result?.content?.[1]?.text).toContain("25s");
		} finally {
			now.mockRestore();
		}
	});

	it("stays silent when the agent introduced the batch", async () => {
		const now = vi.spyOn(Date, "now");
		try {
			const pi = createFakePi();
			narrateExtension(pi.api);

			now.mockReturnValue(1_000);
			await pi.emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Running the full suite; I'll review the diff while it goes." },
						{ type: "toolCall" },
					],
				},
			});

			now.mockReturnValue(1_000 + SLOW_WAIT_MS * 10);
			const handlers = pi.handlers.get("tool_result") ?? [];
			const result = await handlers[0](
				{ type: "tool_result", content: [{ type: "text", text: "out" }] },
				{} as never,
			);
			expect(result).toBeUndefined();
		} finally {
			now.mockRestore();
		}
	});
});
