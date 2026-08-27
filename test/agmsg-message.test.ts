/**
 * The watcher's line format is a CONTRACT with agmsg's watch.sh, not an
 * internal detail: the producer is a `printf` in a bash script that this repo
 * does not own. These tests pin the shapes that actually come off that stream —
 * a body containing the field separator, a multi-line body the producer
 * escaped, and the notices interleaved with the messages.
 *
 * The separator case is not hypothetical: agmsg messages routinely carry shell
 * commands and table output, and a greedy split reassigns their tail to the
 * body field silently.
 */

import { describe, expect, it } from "vitest";

import { formatInjection, isSilentNotice, parseWatchLine, unescapeBody } from "../extensions/agmsg/message.ts";

const LINE = "2026-08-07T02:38:41Z | testteam | bob → alice | hallo alice";

describe("parseWatchLine", () => {
	it("parses a message into its five fields", () => {
		expect(parseWatchLine(LINE)).toEqual({
			kind: "message",
			ts: "2026-08-07T02:38:41Z",
			team: "testteam",
			from: "bob",
			to: "alice",
			body: "hallo alice",
		});
	});

	it("keeps a body that itself contains the field separator", () => {
		const parsed = parseWatchLine(`${LINE} | mit pipe`);
		expect(parsed).toMatchObject({ kind: "message", from: "bob", to: "alice" });
		expect(parsed && "body" in parsed && parsed.body).toBe("hallo alice | mit pipe");
	});

	it("restores newlines the producer escaped", () => {
		const parsed = parseWatchLine("ts | t | a → b | line one\\nline two");
		expect(parsed && "body" in parsed && parsed.body).toBe("line one\nline two");
	});

	it("treats watcher chatter as a notice, never as a message", () => {
		expect(parseWatchLine("agmsg watch: cannot claim (held by other sessions): alice")).toEqual({
			kind: "notice",
			text: "agmsg watch: cannot claim (held by other sessions): alice",
		});
	});

	it("ignores blank lines and strips a trailing CR", () => {
		expect(parseWatchLine("")).toBeNull();
		expect(parseWatchLine("   ")).toBeNull();
		expect(parseWatchLine(`${LINE}\r`)).toMatchObject({ body: "hallo alice" });
	});
});

describe("unescapeBody", () => {
	it("leaves an escaped backslash alone rather than eating the next character", () => {
		expect(unescapeBody("C:\\\\nope")).toBe("C:\\nope");
	});
});

describe("formatInjection", () => {
	const rendered = formatInjection({
		kind: "message",
		ts: "2026-08-07T02:38:41Z",
		team: "testteam",
		from: "bob",
		to: "alice",
		body: "status?",
	});

	it("names the sender, the receiving identity and the body", () => {
		expect(rendered).toContain("bob → alice");
		expect(rendered).toContain("team testteam");
		expect(rendered).toContain("status?");
	});

	it("spells out the reply call, because a plain answer would reach the user instead", () => {
		expect(rendered).toContain('agmsg_send(team: "testteam", to: "bob"');
		expect(rendered).toContain("as alice");
	});
});

describe("isSilentNotice", () => {
	it("swallows the one notice that fires in every unjoined project", () => {
		expect(isSilentNotice("agmsg watch: no available identities (all held by other sessions, or none joined); nothing to do")).toBe(true);
	});

	it("lets a real problem through", () => {
		expect(isSilentNotice("agmsg watch: cannot claim (held by other sessions): alice")).toBe(false);
		expect(isSilentNotice("ERROR: cannot open message DB /x/y.db")).toBe(false);
	});
});
