/**
 * The kernel wire protocol and output shaping — the decisions, not the code.
 *
 * Three of these tests exist because the failure they prevent is silent, which
 * is the only kind worth this much prose:
 *
 *  - a subprocess writing raw bytes into the frame stream must not wedge the
 *    kernel (it must degrade to "that was output"),
 *  - a cell PRINTING something frame-shaped must not be able to end the
 *    execution early,
 *  - a preview must be a TAIL, because the traceback is at the bottom.
 *
 * Everything here is pure: no process, no fs. The spawn side is
 * `kernel-session.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_TIMEOUT_S,
	MAX_TIMEOUT_S,
	MIN_TIMEOUT_S,
	applyFrame,
	emptyExecution,
	encodeRequest,
	parseFrame,
	renderBody,
	renderToolText,
	resolveTimeoutSeconds,
	shapeOutput,
	splitFrames,
	type Execution,
	type Frame,
} from "../extensions/kernel/protocol.ts";

/** Fold a whole transcript, the way `Kernel.execute` does. */
function fold(requestId: string, lines: string[]): Execution {
	let exec = emptyExecution(requestId);
	for (const line of lines) {
		const frame = parseFrame(line);
		if (frame) exec = applyFrame(exec, frame);
	}
	return exec;
}

function frameLine(frame: Partial<Frame> & { type: string; id: string }): string {
	return JSON.stringify(frame);
}

describe("framing", () => {
	it("keeps a partial line rather than truncating a frame at a pipe boundary", () => {
		// A 40KB result does not arrive in one chunk. Dropping the remainder is
		// the bug where a big output "sometimes" loses its last line — which
		// looks like flakiness and is actually arithmetic.
		const first = splitFrames('{"type":"stdout","id":"k1","text":"a"}\n{"type":"stdo');
		expect(first.lines).toHaveLength(1);
		expect(first.rest).toBe('{"type":"stdo');

		const second = splitFrames(`${first.rest}ut","id":"k1","text":"b"}\n`);
		expect(second.lines).toHaveLength(1);
		expect(parseFrame(second.lines[0])?.text).toBe("b");
	});

	it("reads an unparseable line as stdout instead of throwing or dropping it", () => {
		// The measured hole: a cell may `subprocess.Popen` something that inherits
		// fd 1 and writes raw bytes between frames. Closing that hole would mean
		// giving up !cmd and %%bash. Throwing here would let one badly-behaved
		// child stop the kernel answering for the rest of the session.
		const frame = parseFrame("Cloning into 'thing'...");
		expect(frame).toEqual({ type: "stdout", id: "", text: "Cloning into 'thing'..." });
	});

	it("treats well-formed JSON that is not a frame as stray output too", () => {
		// `print(json.dumps(row))` in a loop is completely ordinary. It parses.
		const frame = parseFrame('{"user": 3, "ok": true}');
		expect(frame?.type).toBe("stdout");
		expect(frame?.id).toBe("");
	});

	it("ignores blank lines", () => {
		expect(parseFrame("")).toBeNull();
		expect(parseFrame("   ")).toBeNull();
	});

	it("sends the request as one line, with the timeout in seconds", () => {
		// The runner reads one JSON object per line; a newline inside the encoded
		// form would be read as two requests, the second of them garbage.
		const encoded = encodeRequest({ id: "k1", code: "x = 1\ny = 2", timeout: 30 });
		expect(encoded.endsWith("\n")).toBe(true);
		expect(encoded.trimEnd().includes("\n")).toBe(false);
		expect(JSON.parse(encoded)).toEqual({ id: "k1", code: "x = 1\ny = 2", timeout: 30 });
	});
});

describe("folding an execution", () => {
	it("accumulates streamed output and takes the status from `done`", () => {
		const exec = fold("k1", [
			frameLine({ type: "started", id: "k1", count: 4 }),
			frameLine({ type: "stdout", id: "k1", text: "one\n" }),
			frameLine({ type: "stdout", id: "k1", text: "two\n" }),
			frameLine({ type: "result", id: "k1", text: "42" }),
			frameLine({ type: "done", id: "k1", count: 4, status: "ok" }),
		]);
		expect(exec.stdout).toBe("one\ntwo\n");
		expect(exec.result).toBe("42");
		expect(exec.count).toBe(4);
		expect(exec.status).toBe("ok");
		expect(exec.done).toBe(true);
	});

	it("does NOT let a cell forge a `done` frame for the request in flight", () => {
		// A print of a frame-shaped object arrives as stray output (no id), so the
		// execution stays open. If the id check were dropped, the forged `done`
		// would end the call early and the REAL output would be attributed to
		// whatever ran next — a wrong answer, delivered confidently.
		const exec = fold("k1", [
			frameLine({ type: "stdout", id: "k1", text: "before\n" }),
			'{"type":"done","status":"ok"}',
			frameLine({ type: "stdout", id: "k1", text: "after\n" }),
		]);
		expect(exec.done).toBe(false);
		expect(exec.stdout).toContain("before");
		expect(exec.stdout).toContain("after");
	});

	it("folds a frame belonging to a PREVIOUS request in as output, not as an end", () => {
		// Late frames are real: a cancelled cell's runner can still be flushing
		// when the next request goes out. They are output; they are not this
		// execution's verdict.
		const exec = fold("k2", [
			frameLine({ type: "done", id: "k1", status: "ok" }),
			frameLine({ type: "stdout", id: "k2", text: "mine\n" }),
		]);
		expect(exec.done).toBe(false);
		expect(exec.stdout).toContain("mine");
	});

	it("keeps `cancelled` and `error` apart", () => {
		// Collapsing them into a boolean sends the model debugging a phantom: a
		// cell stopped at its time limit says nothing about the code.
		expect(fold("k1", [frameLine({ type: "done", id: "k1", status: "cancelled" })]).status).toBe("cancelled");
		expect(fold("k1", [frameLine({ type: "done", id: "k1", status: "error" })]).status).toBe("error");
	});
});

describe("rendering the body", () => {
	it("puts the traceback LAST so the tail preview always contains it", () => {
		// The single most misleading output this extension could produce is the
		// first ten lines of a 400-line print with the exception cut off.
		const exec: Execution = {
			...emptyExecution("k1"),
			stdout: "chatter\n".repeat(3),
			error: "Traceback (most recent call last):\nValueError: nope",
		};
		const body = renderBody(exec);
		expect(body.trimEnd().endsWith("ValueError: nope")).toBe(true);
	});

	it("labels stderr and the final expression's value, and omits empty sections", () => {
		const exec: Execution = { ...emptyExecution("k1"), stdout: "hi\n", result: "42" };
		const body = renderBody(exec);
		expect(body).toBe("hi\n[result] 42");
		expect(body).not.toContain("[stderr]");
	});
});

describe("shaping the preview — the token argument for a kernel", () => {
	it("keeps the TAIL when there are too many lines, and counts what it dropped", () => {
		const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const shaped = shapeOutput(body, { maxLines: 10 });
		expect(shaped.complete).toBe(false);
		expect(shaped.omittedLines).toBe(40);
		expect(shaped.preview.split("\n")).toHaveLength(10);
		expect(shaped.preview).toContain("line 49");
		expect(shaped.preview).not.toContain("line 0\n");
	});

	it("clamps one absurdly long line instead of letting a repr through", () => {
		// The case: a single-line 40KB pandas/numpy repr. It is under any line
		// count and it is not cheap, so the line limit is a separate limit.
		const shaped = shapeOutput("x".repeat(5_000), { maxLines: 10, maxLineChars: 200 });
		expect(shaped.complete).toBe(false);
		expect(shaped.preview.length).toBeLessThan(300);
		expect(shaped.preview).toContain("+4800 chars");
	});

	it("caps bytes even when the line count is fine — 300 short lines are still 300 lines", () => {
		const body = Array.from({ length: 10 }, () => "y".repeat(400)).join("\n");
		const shaped = shapeOutput(body, { maxLines: 10, maxLineChars: 10_000, maxBytes: 500 });
		expect(shaped.complete).toBe(false);
		expect(shaped.preview.length).toBeLessThanOrEqual(500);
	});

	it("reports a small output as COMPLETE, so nothing is spilled for nothing", () => {
		// The other half of the decision: an artifact per `print(2+2)` would make
		// the feature annoying and the session directory a landfill.
		const shaped = shapeOutput("4");
		expect(shaped).toEqual({ preview: "4", complete: true, omittedLines: 0 });
		expect(shapeOutput("")).toEqual({ preview: "", complete: true, omittedLines: 0 });
	});
});

describe("what the tool says", () => {
	it("says the output is partial and where the rest is, rather than implying completeness", () => {
		// A model told its output is complete when it is not reasons confidently
		// from a tail. Told where the rest is, it goes and gets it.
		const text = renderToolText({
			exec: { ...emptyExecution("k1"), count: 2, status: "ok", done: true },
			shaped: { preview: "tail", complete: false, omittedLines: 90 },
			ref: "artifact://7",
			artifactPath: "/sessions/abc/7.kernel.log",
			interpreter: "/usr/bin/python3 (system)",
			cwd: "/repo",
		});
		expect(text).toContain("artifact://7");
		expect(text).toContain("90 earlier line");
		expect(text).toContain("/sessions/abc/7.kernel.log");
	});

	it("STILL says the output is partial when no artifact could be written", () => {
		// `spill` returns ref:null on two live paths — the 256-artifact cap and a
		// failed write — plus this extension's own catch. Gating the truncation
		// notice on the ref would make it go silent in exactly the cases where
		// the missing bytes are unrecoverable, which is the worst combination
		// available: a partial answer presented as a whole one.
		const text = renderToolText({
			exec: { ...emptyExecution("k1"), count: 1, status: "ok", done: true },
			shaped: { preview: "tail", complete: false, omittedLines: 90 },
			ref: null,
			interpreter: "python3",
			cwd: "/repo",
		});
		expect(text).toContain("90 earlier line");
		expect(text).toContain("artifact unavailable");
	});

	it("tells the model its variables SURVIVED an interrupt but did NOT survive a crash", () => {
		// These call for opposite next moves. Getting it backwards means either
		// pointlessly recomputing state that is still there, or building on state
		// that is gone.
		const base = { shaped: { preview: "", complete: true, omittedLines: 0 }, ref: null, interpreter: "p", cwd: "/" };
		const interrupted = renderToolText({
			...base,
			exec: { ...emptyExecution("k1"), status: "cancelled", done: true },
		});
		expect(interrupted).toContain("still in the kernel");

		const crashed = renderToolText({
			...base,
			exec: { ...emptyExecution("k1"), status: "crashed", done: true },
		});
		expect(crashed).toContain("state is gone");
	});
});

describe("timeout clamping", () => {
	it("defaults, and refuses both a zero and an unbounded limit", () => {
		expect(resolveTimeoutSeconds(undefined)).toBe(DEFAULT_TIMEOUT_S);
		expect(resolveTimeoutSeconds(Number.NaN)).toBe(DEFAULT_TIMEOUT_S);
		expect(resolveTimeoutSeconds(0)).toBe(MIN_TIMEOUT_S);
		expect(resolveTimeoutSeconds(-5)).toBe(MIN_TIMEOUT_S);
		expect(resolveTimeoutSeconds(999_999)).toBe(MAX_TIMEOUT_S);
		expect(resolveTimeoutSeconds(120)).toBe(120);
	});
});
