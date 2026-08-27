import { describe, expect, it } from "vitest";
import deckExtension from "../extensions/deck/index.ts";
import { DECK_SECTION_CHANNEL, DECK_SYNC_CHANNEL } from "../extensions/deck/protocol.ts";
import planExtension from "../extensions/plan/index.ts";
import { createFakePi, type RecordedWidget } from "./fake-pi.ts";

/**
 * Behavior tests for the deck EXTENSION — the render fold has its own suite
 * (deck-render.test.ts); this one covers what the extension does when pi
 * emits events, which is where this repo's shipped bugs have lived.
 */

/** The stub theme a factory widget needs: identity colors. */
const FAKE_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function lastDeckWidget(widgets: RecordedWidget[]): RecordedWidget | undefined {
	return [...widgets].reverse().find((widget) => widget.key === "deck");
}

function renderLast(widgets: RecordedWidget[], width = 120): string {
	const widget = lastDeckWidget(widgets);
	if (!widget || widget.cleared || !widget.factory) return "";
	return widget.factory(undefined, FAKE_THEME).render(width).join("\n");
}

describe("deck extension", () => {
	it("asks publishers to re-state on session_start — load order is unknown", async () => {
		const fake = createFakePi();
		deckExtension(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });
		expect(fake.busEvents.some((event) => event.name === DECK_SYNC_CHANNEL)).toBe(true);
	});

	it("paints one factory widget under the single 'deck' key and renders through pi-tui", async () => {
		const fake = createFakePi();
		deckExtension(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });

		fake.api.events.emit(DECK_SECTION_CHANNEL, {
			section: "tasks",
			state: { kind: "tasks", rows: [{ status: "in_progress", subject: "ship", activeForm: "Shipping" }] },
		});

		const widget = lastDeckWidget(fake.widgets);
		expect(widget?.cleared).toBe(false);
		expect(widget?.factory).toBeDefined();
		expect(fake.widgets.every((entry) => entry.key === "deck")).toBe(true);
		expect(renderLast(fake.widgets)).toContain("Shipping");
	});

	it("removes the widget entirely when the last section clears", async () => {
		const fake = createFakePi();
		deckExtension(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });

		fake.api.events.emit(DECK_SECTION_CHANNEL, {
			section: "plan",
			state: { kind: "lines", summary: "plan 1/2", lines: ["plan 1/2"] },
		});
		fake.api.events.emit(DECK_SECTION_CHANNEL, { section: "plan", state: null });

		expect(lastDeckWidget(fake.widgets)?.cleared).toBe(true);
	});

	it("ignores malformed bus payloads instead of taking the widget down", async () => {
		const fake = createFakePi();
		deckExtension(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });

		const before = fake.widgets.length;
		fake.api.events.emit(DECK_SECTION_CHANNEL, { section: "nonsense", state: { kind: "???" } });
		fake.api.events.emit(DECK_SECTION_CHANNEL, "not even an object");
		expect(fake.widgets.length).toBe(before);
	});

	it("does not paint before it has a ctx, then paints once it does", () => {
		const fake = createFakePi();
		deckExtension(fake.api);
		// No session_start yet — a publisher that raced ahead must not crash us.
		fake.api.events.emit(DECK_SECTION_CHANNEL, {
			section: "plan",
			state: { kind: "lines", summary: "early", lines: ["early"] },
		});
		expect(fake.widgets).toHaveLength(0);
	});

	it("/deck cycles modes and says which one it landed on", async () => {
		const fake = createFakePi();
		deckExtension(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });
		fake.api.events.emit(DECK_SECTION_CHANNEL, {
			section: "tasks",
			state: {
				kind: "tasks",
				rows: [
					{ status: "pending", subject: "one" },
					{ status: "pending", subject: "two" },
				],
			},
		});

		await fake.runCommand("deck", "expand");
		expect(fake.notifications.some((note) => note.message.includes("deck: expanded"))).toBe(true);
		expect(renderLast(fake.widgets)).toContain("☰ TASKS");

		await fake.runCommand("deck", "collapse");
		const collapsed = renderLast(fake.widgets);
		expect(collapsed).not.toContain("☰ TASKS");
		expect(collapsed).toContain("tasks ☐2");
	});
});

describe("the plan → deck publication", () => {
	it("TodoWrite publishes rows on the deck channel and answers a sync request", async () => {
		const fake = createFakePi();
		planExtension(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });

		const tool = fake.tools.find((entry) => entry.name === "TodoWrite");
		expect(tool).toBeDefined();
		const execute = tool?.definition.execute as (
			id: string,
			params: unknown,
			signal?: unknown,
			onUpdate?: unknown,
			ctx?: unknown,
		) => Promise<unknown>;
		await execute("call-1", { todos: [{ subject: "build the deck", status: "in_progress", activeForm: "Building the deck" }] });

		const published = fake.busEvents.filter((event) => event.name === DECK_SECTION_CHANNEL);
		expect(published.length).toBeGreaterThan(0);
		const last = published[published.length - 1].payload as {
			section: string;
			state: { kind: string; rows: Array<{ activeForm?: string }> };
		};
		// TWO sections, ONE document since HIV-2904. Both readings stay — what am
		// I doing next (rows) and how far along is the plan (summary) — and the
		// plan extension publishes both, so they can no longer disagree the way
		// two separate stores could.
		const rowsSection = published
			.map((event) => event.payload as { section: string; state: { kind: string; rows?: Array<{ activeForm?: string }> } })
			.filter((payload) => payload.section === "tasks")
			.pop();
		expect(rowsSection?.state.rows?.[0].activeForm).toBe("Building the deck");
		expect(last.section).toBe("plan");

		const before = fake.busEvents.length;
		fake.api.events.emit(DECK_SYNC_CHANNEL, {});
		const replies = fake.busEvents.slice(before).filter((event) => event.name === DECK_SECTION_CHANNEL);
		expect(replies).toHaveLength(2);
	});

	it("never calls setWidget itself — the deck owns the slot", async () => {
		const fake = createFakePi();
		planExtension(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });
		expect(fake.widgets).toHaveLength(0);
	});
});
