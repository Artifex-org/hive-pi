/**
 * Ported from hive's `cmd/hive-agent/workstation_logrepaint_test.go`.
 *
 * The port is deliberate duplication: hive's Go collapser writes the tmux
 * capture, this one writes the model's tool result, and the two must agree.
 * Keeping the Go fixtures verbatim means a divergence fails HERE rather than
 * showing up as a mysterious difference between what the pane recorded and what
 * the model was told.
 *
 * The CRLF cases are NEW and matter far more here than in Go: a pty applies
 * ONLCR, so every line arrives `\r\n`. A collapser that mistook a trailing CR
 * for a repaint would delete the entire stream — and it would pass every test
 * that only used `\n`.
 */

import { describe, expect, it } from "vitest";

import { AnsiStripper, normalizeCRLF } from "../extensions/pty-exec/ansi.ts";
import { RepaintCollapser, collapseCarriageReturns } from "../extensions/pty-exec/repaint.ts";

/**
 * One frame of pi's status line, copied from the Go test, which copied it from
 * a real capture on a linux workstation (agent-a167402e). ~180 bytes to say nothing,
 * ten times a second.
 */
const spinnerFrame =
	"\r\x1b[2K \x1b[38;2;110;127;199m⣷\x1b[39m \x1b[38;2;158;158;158mWorking...\x1b[39m" +
	" ".repeat(67) +
	"\x1b[0m\x1b]8;;\x07\x1b[?2026l\x1b[4B\x1b[1G\x1b[?25l\x1b[?2026h\x1b[4A";

function collapsed(...chunks: string[]): string {
	const out: Buffer[] = [];
	const c = new RepaintCollapser((b) => void out.push(b));
	for (const chunk of chunks) c.write(Buffer.from(chunk));
	c.close();
	return Buffer.concat(out).toString();
}

function stripped(...chunks: string[]): string {
	const s = new AnsiStripper();
	const out: Buffer[] = [];
	for (const chunk of chunks) out.push(s.write(Buffer.from(chunk)));
	out.push(s.close());
	return Buffer.concat(out).toString();
}

/**
 * The full model-sink pipeline: strip → normalizeCRLF → collapse.
 *
 * The CRLF step sits BEFORE the collapser. With it after (the intuitive order)
 * the collapser sees every line ending in CR, reads each one as a line ending
 * rather than a repaint, and collapses nothing at all — the end-to-end test
 * below caught exactly that, with all 200 spinner frames intact.
 */
function modelSink(...chunks: string[]): string {
	const s = new AnsiStripper();
	const out: Buffer[] = [];
	const c = new RepaintCollapser((b) => void out.push(b));
	for (const chunk of chunks) c.write(normalizeCRLF(s.write(Buffer.from(chunk))));
	c.close();
	return Buffer.concat(out).toString();
}

describe("collapseCarriageReturns", () => {
	it("keeps only the text after the last carriage return in a line", () => {
		expect(collapseCarriageReturns(Buffer.from("aaa\rbbb\n")).toString()).toBe("bbb\n");
	});

	// The guard that a pty makes load-bearing.
	it("treats a trailing CRLF as a line ending, not a repaint", () => {
		expect(collapseCarriageReturns(Buffer.from("first\r\nsecond\r\n")).toString()).toBe("first\r\nsecond\r\n");
	});

	it("returns the input untouched when there is no carriage return", () => {
		const b = Buffer.from("plain\noutput\n");
		expect(collapseCarriageReturns(b)).toBe(b);
	});
});

describe("RepaintCollapser", () => {
	// The bug this fixes: a spinner filled the whole 4 MiB bounded capture, so
	// the 16 KiB tail that HIV-1418 reports as evidence held only spinner.
	it("keeps real output and drops the spinner that buried it", () => {
		let stream = "go test ./internal/store\n";
		for (let i = 0; i < 5000; i++) stream += spinnerFrame;
		stream += "\r\x1b[2Kpanic: runtime error: index out of range\n";

		const got = collapsed(stream);

		expect(got).toContain("panic: runtime error");
		expect(got).toContain("go test ./internal/store");
		// Only the last state of a repainted line is durable.
		expect(got.split("Working...").length - 1).toBeLessThanOrEqual(1);
		// 5000 frames is ~900 KB raw; collapsed it must be a rounding error.
		expect(got.length).toBeLessThan(4 << 10);
	});

	it("passes newline-terminated output through unchanged", () => {
		const input = "first\nsecond\r\nthird\n";
		expect(collapsed(input)).toBe(input);
	});

	it("survives a frame split across chunk boundaries", () => {
		// A 64 KiB read can split anywhere, including between the \r and the text
		// that overwrites the line.
		expect(collapsed("downloading 1%\r", "downloading 2%\rdownloading 3%", "\rdone\n")).toBe("done\n");
	});

	// A command killed mid-run never emits a closing newline. That last
	// unterminated frame is the whole post-mortem, so close() must write it.
	it("flushes an unterminated tail on close", () => {
		expect(collapsed(spinnerFrame, "\r\x1b[2K$ git push --force-with-lease")).toContain(
			"git push --force-with-lease",
		);
	});
});

describe("AnsiStripper", () => {
	it("removes SGR colour without touching the text", () => {
		expect(stripped("\x1b[31mred\x1b[0m and plain\n")).toBe("red and plain\n");
	});

	// The case a stateless regex gets wrong, and only under load.
	it("strips an escape split across two chunks", () => {
		expect(stripped("before\x1b", "[31mafter\n")).toBe("beforeafter\n");
	});

	it("strips an OSC terminated by BEL and by ST", () => {
		expect(stripped("\x1b]0;my title\x07text\n")).toBe("text\n");
		expect(stripped("\x1b]8;;http://example.com\x1b\\link\n")).toBe("link\n");
	});

	it("strips an OSC split mid-string", () => {
		expect(stripped("\x1b]0;ti", "tle\x07done\n")).toBe("done\n");
	});

	// \r must survive: the collapser downstream needs it to tell a repaint from
	// a line ending. Stripping it here would silently disable repaint collapsing.
	it("keeps carriage return, newline and tab", () => {
		expect(stripped("a\tb\r\nc\n")).toBe("a\tb\r\nc\n");
	});

	it("drops an incomplete sequence rather than emitting its fragment", () => {
		expect(stripped("text\x1b[")).toBe("text");
	});
});

describe("normalizeCRLF", () => {
	it("collapses CRLF to LF but keeps a bare CR", () => {
		expect(normalizeCRLF(Buffer.from("a\r\nb\rc\n")).toString()).toBe("a\nb\rc\n");
	});
});

describe("the model sink end to end", () => {
	// What a real pty run of a spinner-emitting command must look like by the
	// time the model sees it.
	it("turns a pty spinner stream into clean plain text", () => {
		let stream = "$ go build ./...\r\n";
		for (let i = 0; i < 200; i++) stream += spinnerFrame;
		stream += "\r\x1b[2K\x1b[32mok\x1b[0m  compiled 12 packages\r\n";

		const got = modelSink(stream);

		expect(got).toBe("$ go build ./...\nok  compiled 12 packages\n");
		expect(got).not.toContain("\x1b");
		expect(got).not.toContain("\r");
	});
});
