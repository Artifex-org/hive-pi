/**
 * The stale-question guard.
 *
 * The failure it prevents is the worst one available to unattended re-entry:
 * an automatic turn lands on a question the assistant asked the user, answers
 * it with the policy's prompt, and the model proceeds on a decision the human
 * never made. It is silent and it looks like progress.
 *
 * Most of these cases are about NOT firing. A guard that false-positives stalls
 * every gate injection whose preceding turn happened to contain a regex.
 */

import { describe, expect, it } from "vitest";
import { blocksReentry, endsWithQuestion } from "../extensions/agenda/question-guard.ts";

describe("endsWithQuestion — fires", () => {
	it.each([
		["a bare question", "Should I proceed?"],
		["trailing newlines", "Ready to deploy?\n\n"],
		["a trailing space", "Which one? "],
		["a closing paren after the mark", "Shall I continue? )"],
		["a markdown bold wrapper", "**Proceed?**"],
		["a blockquote marker", "> Do you want me to retry?"],
		["a question after prose", "I found three options. Which should I use?"],
	])("%s", (_label, text) => {
		expect(endsWithQuestion(text)).toBe(true);
	});
});

describe("endsWithQuestion — stays quiet", () => {
	it.each([
		["a statement", "I fixed the build."],
		["empty text", ""],
		["a question mid-paragraph, resolved after", "Should I retry? I retried, and it passed."],
		["a question mark inside a fenced block", "Done.\n\n```sh\ngrep -q 'x' && echo '?'\n```"],
		["a fenced block that IS the last thing", "Here is the command:\n\n```\ntest -f x || echo ?\n```"],
		["an unterminated fence", "Running:\n\n```sh\nfoo --bar ?"],
		["a question mark in inline code", "Use the `?` operator."],
		["a regex ending the message", "Matched with `/ab?c/`"],
		["a URL query string", "See https://example.com/x?y=1"],
	])("%s", (_label, text) => {
		expect(endsWithQuestion(text)).toBe(false);
	});
});

describe("blocksReentry", () => {
	it("blocks an automatic re-entry after a question", () => {
		expect(blocksReentry({ lastAssistantText: "Which branch?", automatic: true })).toBe(true);
	});

	it("never blocks a human-initiated turn", () => {
		// A human who types while their own question is on screen has answered it.
		expect(blocksReentry({ lastAssistantText: "Which branch?", automatic: false })).toBe(false);
	});

	it("does not block when the last turn was a statement", () => {
		expect(blocksReentry({ lastAssistantText: "Deployed.", automatic: true })).toBe(false);
	});

	it("fails OPEN when there is no transcript to inspect", () => {
		// A missing or unreadable transcript must not silently stall a legitimate
		// gate injection — the guard only ever acts on positive evidence.
		expect(blocksReentry({ lastAssistantText: undefined, automatic: true })).toBe(false);
	});
});
