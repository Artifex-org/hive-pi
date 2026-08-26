import { describe, expect, it } from "vitest";
import {
	MAX_LINES,
	MAX_TEXT,
	sanitizeSectionEvent,
	type DeckSectionId,
	type DeckSectionState,
} from "../extensions/deck/protocol.ts";
import {
	PLAIN_STYLE,
	QUIET_AFTER_MS,
	TASK_ROW_CAP,
	TOTAL_CAP,
	isLive,
	renderDeck,
	sectionSummary,
} from "../extensions/deck/render.ts";

const NOW = 1_000_000;

function sections(entries: Array<[DeckSectionId, DeckSectionState]>): Map<DeckSectionId, DeckSectionState> {
	return new Map(entries);
}

function tasksState(rows: Array<{ status: "pending" | "in_progress" | "completed"; subject: string; activeForm?: string; blocked?: boolean }>): DeckSectionState {
	return { kind: "tasks", rows };
}

describe("sanitizeSectionEvent — bus input is untrusted", () => {
	it("rejects non-objects, unknown sections, and unknown kinds", () => {
		expect(sanitizeSectionEvent(null)).toBeNull();
		expect(sanitizeSectionEvent("deck")).toBeNull();
		expect(sanitizeSectionEvent({ section: "footer", state: null })).toBeNull();
		expect(sanitizeSectionEvent({ section: "tasks", state: { kind: "mystery" } })).toBeNull();
	});

	it("null state clears the slot", () => {
		expect(sanitizeSectionEvent({ section: "plan", state: null })).toEqual({ section: "plan", state: null });
	});

	it("clamps oversized text and caps line counts", () => {
		const event = sanitizeSectionEvent({
			section: "plan",
			state: { kind: "lines", summary: "x".repeat(MAX_TEXT + 50), lines: Array(MAX_LINES + 10).fill("line") },
		});
		expect(event).not.toBeNull();
		const state = event?.state as unknown as { summary: string; lines: string[] };
		expect(state.summary.length).toBeLessThanOrEqual(MAX_TEXT);
		expect(state.lines).toHaveLength(MAX_LINES);
	});

	it("drops malformed rows instead of rejecting the section", () => {
		const event = sanitizeSectionEvent({
			section: "tasks",
			state: {
				kind: "tasks",
				rows: [
					{ status: "pending", subject: "good" },
					{ status: "exploded", subject: "bad status" },
					{ status: "completed" },
					"not a row",
				],
			},
		});
		const state = event?.state as unknown as { rows: unknown[] };
		expect(state.rows).toHaveLength(1);
	});

	it("requires startedAtMs on agent rows — elapsed time is computed from it", () => {
		const event = sanitizeSectionEvent({
			section: "subagents",
			state: {
				kind: "subagents",
				mode: "parallel",
				rows: [
					{ agent: "researcher", state: "running", startedAtMs: NOW },
					{ agent: "no-clock", state: "running" },
				],
			},
		});
		const state = event?.state as unknown as { rows: unknown[] };
		expect(state.rows).toHaveLength(1);
	});
});

describe("renderDeck", () => {
	it("returns null when there is nothing to say — the widget is removed, not blanked", () => {
		expect(renderDeck(sections([]), "auto", NOW, PLAIN_STYLE)).toBeNull();
	});

	it("collapsed mode folds everything into one line, in section order", () => {
		const lines = renderDeck(
			sections([
				["plan", { kind: "lines", summary: "plan 4/9", lines: ["plan 4/9"] }],
				["tasks", tasksState([{ status: "pending", subject: "a" }])],
			]),
			"collapsed",
			NOW,
			PLAIN_STYLE,
		);
		expect(lines).toHaveLength(1);
		// SECTION_ORDER puts tasks before plan regardless of arrival order.
		expect(lines?.[0]).toMatch(/tasks ☐1 ⧗0 ☑0.*plan 4\/9/);
	});

	it("the collapsed tasks segment names the active task", () => {
		const summary = sectionSummary({
			kind: "tasks",
			rows: [
				{ status: "completed", subject: "read the code" },
				{ status: "in_progress", subject: "write tests", activeForm: "Writing tests" },
			],
		});
		expect(summary).toContain("Writing tests");
	});

	it("expanded tasks render activeForm on the active row and subject elsewhere", () => {
		const lines = renderDeck(
			sections([
				[
					"tasks",
					tasksState([
						{ status: "completed", subject: "read the code" },
						{ status: "in_progress", subject: "write tests", activeForm: "Writing tests" },
						{ status: "pending", subject: "ship it", blocked: true },
					]),
				],
			]),
			"expanded",
			NOW,
			PLAIN_STYLE,
		);
		const body = lines?.join("\n") ?? "";
		expect(body).toContain("Writing tests");
		expect(body).not.toContain("write tests");
		expect(body).toContain("read the code");
		expect(body).toContain("ship it (blocked)");
	});

	it("caps task rows with +N more but never hides the active row", () => {
		const rows = Array.from({ length: TASK_ROW_CAP + 5 }, (_, i) => ({
			status: "pending" as const,
			subject: `task ${i}`,
		}));
		rows.push({ status: "in_progress" as const, subject: "the active one" } as never);
		const lines = renderDeck(sections([["tasks", tasksState(rows)]]), "expanded", NOW, PLAIN_STYLE);
		const body = lines?.join("\n") ?? "";
		expect(body).toContain("+6 more");
		expect(body).toContain("the active one");
	});

	it("subagents: running rows first, all in-flight states read as working, quiet marker after silence", () => {
		const lines = renderDeck(
			sections([
				[
					"subagents",
					{
						kind: "subagents",
						mode: "parallel",
						rows: [
							{ agent: "done-early", state: "done", startedAtMs: NOW - 60_000, usage: "2 turns" },
							{
								agent: "quiet-worker",
								state: "running",
								startedAtMs: NOW - 200_000,
								lastActivityAtMs: NOW - QUIET_AFTER_MS - 5_000,
							},
							{ agent: "busy-worker", state: "running", startedAtMs: NOW - 10_000, lastActivityAtMs: NOW },
						],
					},
				],
			]),
			"auto",
			NOW,
			PLAIN_STYLE,
		);
		const body = lines?.join("\n") ?? "";
		const quietIndex = body.indexOf("quiet-worker");
		const doneIndex = body.indexOf("done-early");
		expect(quietIndex).toBeGreaterThanOrEqual(0);
		expect(quietIndex).toBeLessThan(doneIndex);
		expect(body).toMatch(/quiet-worker.*working — no event/);
		expect(body).toMatch(/busy-worker.*working/);
		expect(body).not.toMatch(/busy-worker.*no event/);
		expect(body).toContain("2 turns");
	});

	it("folds finished agents beyond the linger window into a count", () => {
		const rows = [
			{ agent: "live", state: "running" as const, startedAtMs: NOW },
			...Array.from({ length: 6 }, (_, i) => ({
				agent: `done-${i}`,
				state: "done" as const,
				startedAtMs: NOW - 5_000,
			})),
		];
		const lines = renderDeck(
			sections([["subagents", { kind: "subagents", mode: "parallel", rows }]]),
			"expanded",
			NOW,
			PLAIN_STYLE,
		);
		const body = lines?.join("\n") ?? "";
		expect(body).toContain("3 more finished");
	});

	it("auto mode expands live sections and folds idle ones into a trailing summary", () => {
		const lines = renderDeck(
			sections([
				["tasks", tasksState([{ status: "pending", subject: "later" }])],
				[
					"subagents",
					{
						kind: "subagents",
						mode: "single",
						rows: [{ agent: "worker", state: "running", startedAtMs: NOW - 5_000 }],
					},
				],
			]),
			"auto",
			NOW,
			PLAIN_STYLE,
		);
		const body = lines?.join("\n") ?? "";
		expect(body).toContain("◈ SUBAGENTS");
		expect(body).not.toContain("☰ TASKS");
		// The folded summary sits last, adjacent to the editor.
		expect(lines?.[lines.length - 1]).toContain("tasks ☐1");
	});

	it("auto mode with nothing live is exactly the collapsed line", () => {
		const idle = sections([["tasks", tasksState([{ status: "pending", subject: "later" }])]]);
		expect(renderDeck(idle, "auto", NOW, PLAIN_STYLE)).toEqual(renderDeck(idle, "collapsed", NOW, PLAIN_STYLE));
	});

	it("surfaces waiting-on-input as a leading attention segment", () => {
		const lines = renderDeck(
			sections([
				["plan", { kind: "lines", summary: "plan 1/2", lines: ["plan 1/2"], waitingOnInput: 2 }],
			]),
			"collapsed",
			NOW,
			PLAIN_STYLE,
		);
		expect(lines?.[0]).toContain("⚠ 2 waiting on input");
	});

	it("caps total output and says so", () => {
		const lines = renderDeck(
			sections([
				[
					"orchestrate",
					{ kind: "lines", summary: "run", lines: Array.from({ length: MAX_LINES }, (_, i) => `node ${i}`), live: true },
				],
				["conductor", { kind: "lines", summary: "conductor", lines: Array.from({ length: MAX_LINES }, (_, i) => `stage ${i}`), live: true }],
			]),
			"expanded",
			NOW,
			PLAIN_STYLE,
		);
		expect(lines?.length).toBeLessThanOrEqual(TOTAL_CAP + 1);
		expect(lines?.[lines.length - 1]).toContain("deck truncated");
	});

	it("isLive: running subagents and live line-sections keep the tick alive; idle state does not", () => {
		expect(isLive({ kind: "subagents", mode: "single", rows: [{ agent: "a", state: "running", startedAtMs: NOW }] })).toBe(true);
		expect(isLive({ kind: "subagents", mode: "single", rows: [{ agent: "a", state: "done", startedAtMs: NOW }] })).toBe(false);
		expect(isLive({ kind: "lines", summary: "s", lines: [], live: true })).toBe(true);
		expect(isLive({ kind: "tasks", rows: [] })).toBe(false);
	});
});
