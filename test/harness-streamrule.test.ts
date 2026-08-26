import { describe, expect, it } from "vitest";

import {
	buildReminder,
	DEFAULT_WINDOW,
	holdBack,
	HOUSE_RULES,
	interceptStream,
	type StreamRule,
} from "../extensions/harness/streamrule.ts";

const RULE: StreamRule = { name: "no-foo", pattern: /FORBIDDEN/, reminder: "Do not write FORBIDDEN." };

/** Split text into small chunks, the way a provider streams it. */
function* chunks(text: string, size = 7) {
	for (let i = 0; i < text.length; i += size) yield { text: text.slice(i, i + size) };
}

async function* stream(text: string, size = 7) {
	for (const chunk of chunks(text, size)) yield chunk;
}

describe("holdBack", () => {
	it("holds everything while under the window", () => {
		const result = holdBack("short", [RULE], 100);
		expect(result.emit).toBe("");
		expect(result.held).toBe("short");
	});

	it("releases the excess once past the window, keeping the tail held", () => {
		const text = "a".repeat(150);
		const result = holdBack(text, [RULE], 100);
		expect(result.emit).toHaveLength(50);
		expect(result.held).toHaveLength(100);
		expect(result.emit + result.held).toBe(text);
	});

	it("emits NOTHING once a rule matches — the whole point", () => {
		const result = holdBack("some text FORBIDDEN more", [RULE], 5);
		expect(result.emit).toBe("");
		expect(result.violation?.name).toBe("no-foo");
	});

	it("catches a match that would otherwise have been released", () => {
		// The match sits beyond the window, so without the rule check the leading
		// text would already be public. The rule check runs first, deliberately.
		const text = `FORBIDDEN${"x".repeat(300)}`;
		expect(holdBack(text, [RULE], 100).emit).toBe("");
	});

	it("does not mutate a global regex's lastIndex across calls", () => {
		const globalRule: StreamRule = { name: "g", pattern: /BAD/g, reminder: "no" };
		expect(holdBack("BAD", [globalRule], 10).violation).toBeDefined();
		// A naive implementation reusing the same RegExp misses the second call.
		expect(holdBack("BAD", [globalRule], 10).violation).toBeDefined();
	});
});

describe("interceptStream", () => {
	it("passes clean output through unchanged", async () => {
		const text = "a perfectly ordinary answer with no problems in it";
		const outcome = await interceptStream(() => stream(text), [RULE], { window: 10 });
		expect(outcome.emitted).toBe(text);
		expect(outcome.violations).toHaveLength(0);
		expect(outcome.reissues).toBe(0);
	});

	it("suppresses the violation and re-issues with a reminder", async () => {
		let call = 0;
		const outcome = await interceptStream(
			(reminders) => {
				call++;
				// First attempt violates; the re-issue (which now carries a reminder)
				// behaves.
				return call === 1 ? stream("here goes FORBIDDEN stuff") : stream(`clean answer (${reminders.length} reminder)`);
			},
			[RULE],
			{ window: 50 },
		);
		expect(outcome.violations).toHaveLength(1);
		expect(outcome.reissues).toBe(1);
		expect(outcome.emitted).toBe("clean answer (1 reminder)");
		// The forbidden text never reached the caller.
		expect(outcome.emitted).not.toContain("FORBIDDEN");
	});

	it("gives up after maxReissues rather than looping forever", async () => {
		const outcome = await interceptStream(() => stream("always FORBIDDEN"), [RULE], {
			window: 50,
			maxReissues: 2,
		});
		expect(outcome.reissues).toBe(3);
		expect(outcome.violations).toHaveLength(3);
		expect(outcome.emitted).toBe("");
	});

	it("THE CEILING: text already released cannot be retracted", async () => {
		// The violation appears only after far more than the window has streamed,
		// so the early text is public before the rule can fire. This is the
		// documented limit, pinned as a test so nobody claims otherwise later.
		const prefix = "x".repeat(500);
		let call = 0;
		const outcome = await interceptStream(
			() => (++call === 1 ? stream(`${prefix} FORBIDDEN`) : stream("")),
			[RULE],
			{ window: 20 },
		);
		expect(outcome.violations).toHaveLength(1);
		// Some of the prefix WAS emitted — window-limited, not retract-and-retry.
		expect(outcome.emitted.length).toBeGreaterThan(0);
		expect(outcome.emitted).not.toContain("FORBIDDEN");
	});

	it("flushes the held window when a clean stream ends", async () => {
		const outcome = await interceptStream(() => stream("tiny"), [RULE], { window: DEFAULT_WINDOW });
		expect(outcome.emitted).toBe("tiny");
	});
});

describe("buildReminder", () => {
	it("names the rule and quotes what was discarded", () => {
		const reminder = buildReminder(RULE, "about to write FORBIDDEN");
		expect(reminder).toContain('rule="no-foo"');
		expect(reminder).toContain("Do not write FORBIDDEN.");
		expect(reminder).toContain("discarded before it was shown");
	});

	it("truncates a long suppression from the front", () => {
		expect(buildReminder(RULE, "y".repeat(500))).toContain("…");
	});
});

describe("HOUSE_RULES", () => {
	const fires = (text: string) => HOUSE_RULES.some((r) => new RegExp(r.pattern.source).test(text));

	it("catches the suppression directives the autofix lesson named", () => {
		expect(fires("value  # type: ignore")).toBe(true);
		expect(fires("x = 1  # noqa")).toBe(true);
		expect(fires("// eslint-disable-next-line")).toBe(true);
		expect(fires("// @ts-expect-error")).toBe(true);
	});

	it("catches unsafe casts and sleep-polls", () => {
		expect(fires("const x = y as unknown as Foo;")).toBe(true);
		expect(fires("sleep 30; kubectl get pods")).toBe(true);
	});

	it("leaves ordinary code alone", () => {
		expect(fires("const x = y as Foo;")).toBe(false);
		expect(fires("until ready; do sleep 30; done")).toBe(false);
		expect(fires("function typeIgnore() {}")).toBe(false);
	});
});
