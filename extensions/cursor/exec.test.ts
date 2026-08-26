import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	EXEC_IMPLEMENTED_KINDS,
	EXEC_REQUEST_KINDS,
	EXEC_TRANSPORT_KINDS,
	capabilityRule,
	execKind,
	handleExec,
	refusalFor,
	refusedKinds,
	type ExecBridge,
} from "./exec.ts";

/** A bridge whose tools are stubs, so the mapping is tested without a filesystem. */
function stubBridge(over: Partial<Record<string, unknown>> = {}, cwd = "/ws"): ExecBridge {
	const ok = (text: string, details?: unknown) => ({
		execute: async () => ({ content: [{ type: "text", text }], details }),
	});
	return {
		cwd,
		read: ok("file contents"),
		write: ok("written"),
		ls: ok("a.ts\nb.ts"),
		grep: ok("src/a.ts:1:match\nsrc/b.ts:9:match"),
		bash: ok("stdout here", { exitCode: 0 }),
		...over,
	} as unknown as ExecBridge;
}

const throwing = { execute: async () => { throw new Error("boom"); } };

describe("exec bridge", () => {
	// THE property that keeps a turn alive. Cursor's loop waits inside the stream
	// for a result; pi's tools THROW on failure. An escaping exception would
	// abandon the stream mid-turn, and the model would see a hang rather than a
	// failure it could route around.
	it("turns a throwing tool into an error result, never an exception", async () => {
		const out = await handleExec(stubBridge({ read: throwing }), {
			id: 7,
			execId: "e1",
			readArgs: { path: "a.ts", toolCallId: "t1" },
		});
		expect(out).not.toBeNull();
		const msg = out!.message as any;
		expect(msg.readResult.error.error).toContain("boom");
		expect(msg.readResult.success).toBeUndefined();
		// The envelope must echo the ids or Cursor cannot match the reply to its
		// request, and waits forever anyway.
		expect(msg.id).toBe(7);
		expect(msg.execId).toBe("e1");
	});

	// An unimplemented call must be reported as unhandled so the CALLER can refuse
	// explicitly. Returning a fake success would be worse than the stall: the
	// model would build on a result that never happened.
	it("returns null for a call it does not implement", async () => {
		expect(await handleExec(stubBridge(), { computerUseArgs: {} })).toBeNull();
		expect(execKind({ computerUseArgs: {} })).toBe("computerUse");
		expect(execKind({})).toBe("unknown");
	});

	it("reads a file and reports the size of what it handed over", async () => {
		const out = await handleExec(stubBridge(), { readArgs: { path: "a.ts", toolCallId: "t" } });
		const s = (out!.message as any).readResult.success;
		expect(s.content).toBe("file contents");
		expect(s.path).toBe("a.ts");
		// Size of the text the MODEL received, not of the file on disk: if pi
		// truncated, claiming the on-disk size would tell the model it has content
		// it was never given.
		expect(s.fileSize).toBe(Buffer.byteLength("file contents", "utf8"));
	});

	// Binary writes are refused rather than attempted. pi's write tool takes text,
	// so "decoding" base64 fileBytes through it would silently corrupt any
	// non-UTF8 payload -- a corruption the model could not detect and would
	// report as a successful write.
	it("refuses a binary write instead of mangling it", async () => {
		const out = await handleExec(stubBridge(), {
			writeArgs: { path: "img.png", fileBytes: "AAEC", toolCallId: "t" },
		});
		const r = (out!.message as any).writeResult;
		expect(r.success).toBeUndefined();
		expect(r.error.error).toContain("binary");
	});

	it("writes text and reports what it wrote", async () => {
		const out = await handleExec(stubBridge(), {
			writeArgs: { path: "a.ts", fileText: "one\ntwo", toolCallId: "t" },
		});
		const s = (out!.message as any).writeResult.success;
		expect(s.linesCreated).toBe(2);
		expect(s.fileContentAfterWrite).toBeUndefined(); // not requested
	});

	it("returns the written content only when Cursor asked for it", async () => {
		const out = await handleExec(stubBridge(), {
			writeArgs: {
				path: "a.ts",
				fileText: "x",
				toolCallId: "t",
				returnFileContentAfterWrite: true,
			},
		});
		expect((out!.message as any).writeResult.success.fileContentAfterWrite).toBe("x");
	});

	// grep answers in files mode whatever was asked, because reconstructing
	// per-line matches would mean parsing pi's presentation format -- brittle, and
	// wrong in a way the model could not detect.
	it("reports grep as distinct matching file paths", async () => {
		const out = await handleExec(stubBridge(), {
			grepArgs: { pattern: "match", toolCallId: "t" },
		});
		const s = (out!.message as any).grepResult.success;
		expect(s.outputMode).toBe("files_with_matches");
		expect(s.workspaceResults["/ws"].files.files).toEqual(["src/a.ts", "src/b.ts"]);
		expect(s.workspaceResults["/ws"].files.totalFiles).toBe(2);
	});

	it("reports a failed shell command as a failure with a non-zero code", async () => {
		const out = await handleExec(stubBridge({ bash: throwing }), {
			shellArgs: { command: "false", toolCallId: "t" },
		});
		const f = (out!.message as any).shellResult.failure;
		// NOT zero. A tool that threw did not report an exit code, and inventing 0
		// would tell the model the command succeeded.
		expect(f.exitCode).toBe(1);
		expect(f.stderr).toContain("boom");
	});

	it("carries the shell exit code through on success", async () => {
		const out = await handleExec(stubBridge({
			bash: { execute: async () => ({ content: [{ type: "text", text: "out" }], details: { exitCode: 3 } }) },
		}), { shellArgs: { command: "x", toolCallId: "t" } });
		expect((out!.message as any).shellResult.success.exitCode).toBe(3);
	});
});

describe("delete", () => {
	// Distinguished from a generic error on purpose: "already gone" is a state the
	// model can proceed from, while an unexplained error usually triggers a retry.
	it("reports a missing file as fileNotFound, not an error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-exec-"));
		const out = await handleExec(stubBridge({}, dir), {
			deleteArgs: { path: "nope.txt", toolCallId: "t" },
		});
		const r = (out!.message as any).deleteResult;
		expect(r.fileNotFound).toBeDefined();
		expect(r.error).toBeUndefined();
	});

	it("deletes a file and returns its previous content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-exec-"));
		writeFileSync(join(dir, "gone.txt"), "old text");
		const out = await handleExec(stubBridge({}, dir), {
			deleteArgs: { path: "gone.txt", toolCallId: "t" },
		});
		const s = (out!.message as any).deleteResult.success;
		// Recoverable from the transcript: this is the one path that touches the
		// filesystem directly, with no pi tool wrapping it.
		expect(s.prevContent).toBe("old text");
		expect(() => readFileSync(join(dir, "gone.txt"))).toThrow();
	});

	it("refuses to delete a directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-exec-"));
		const out = await handleExec(stubBridge({}, dir), {
			deleteArgs: { path: ".", toolCallId: "t" },
		});
		expect((out!.message as any).deleteResult.notFile).toBeDefined();
	});
});

describe("capability rule", () => {
	it("names the grep limitation the model would otherwise discover by failing", () => {
		const rule = capabilityRule();
		expect(rule).toMatch(/grep/i);
		// The specific surprise: grep returns paths, not matching lines.
		expect(rule).toMatch(/FILE PATHS/);
		expect(rule).toMatch(/binary writes/i);
	});
});

// HIV-2216. The stall that read as "a large tool result kills the turn" was
// never about the payload: a big result gets truncated, truncation sends the
// model to the shell to check what it could not read, and that extra traffic
// eventually reaches an exec kind nothing answers. Answering in the wrong oneof
// case is indistinguishable from not answering at all — the server discards it
// and the turn waits for a frame that will never come.
//
// So coverage is the invariant, and it is asserted against the protocol's own
// list rather than against whatever we happen to have implemented.
describe("exec coverage", () => {
	it("answers every request kind the protocol can send", () => {
		const covered = new Set<string>([
			...EXEC_IMPLEMENTED_KINDS,
			...EXEC_TRANSPORT_KINDS,
			...refusedKinds(),
		]);
		const uncovered = EXEC_REQUEST_KINDS.filter((k) => !covered.has(k));
		expect(uncovered).toEqual([]);
	});

	// The two that were actually missing, named so a revert is legible.
	it.each([
		["writeShellStdinArgs", "writeShellStdinResult"],
		["computerUseArgs", "computerUseResult"],
		["shellStreamArgs", "shellStream"],
		["fetchArgs", "fetchResult"],
	])("refuses %s in its own result case (%s)", (args, want) => {
		const body = refusalFor({ [args]: {} }, "unsupported");
		expect(Object.keys(body)).toEqual([want]);
	});

	// A kind we have never seen must still be DISPATCHABLE. The old fallback
	// answered anything unlisted with a shellResult, which is the drop this
	// whole class is made of.
	it("answers an unknown future kind in a derived result case, not a shellResult", () => {
		const body = refusalFor({ holodeckArgs: {} }, "unsupported");
		expect(Object.keys(body)).toEqual(["holodeckResult"]);
		expect(body).not.toHaveProperty("shellResult");
	});

	// ...except a plain shell, whose refusal carries a command/exit code the
	// model reads as a failed command rather than an absent capability.
	it("keeps the shell refusal shaped like a failed command", () => {
		const body = refusalFor({ shellArgs: {} }, "nope") as Record<string, any>;
		expect(body.shellResult.failure.stderr).toBe("nope");
	});
});

// A streamed shell is answered as a SEQUENCE, and the sequence is only an answer
// once its terminal frame arrives.
//
// MEASURED 2026-08-19 against the live server: a `shellStream` sent as
// start + stdout with no `exit` produced 135 seconds of silence — identical to
// answering in the wrong oneof case entirely, and identical to sending nothing.
// The same harness with the exit frame added got 14 frames back and the turn
// carried on. So "incomplete" and "dropped" are the same failure, and the
// invariant worth pinning is not "we replied" but "we finished replying".
describe("a streamed shell must terminate", () => {
	const streamArgs = {
		id: 3,
		execId: "e9",
		shellStreamArgs: { command: "echo hi", toolCallId: "t9", workingDirectory: "/ws" },
	};

	// Reaches into the frames the caller will actually put on the wire, in order.
	const frames = (out: NonNullable<Awaited<ReturnType<typeof handleExec>>>) =>
		[...(out.precedingMessages ?? []), out.message] as any[];

	it("ends a successful stream with an exit frame", async () => {
		const out = await handleExec(stubBridge(), streamArgs);
		expect(out).not.toBeNull();
		const seq = frames(out!);
		// Every frame belongs to the same request, or the server cannot match them.
		for (const f of seq) {
			expect(f.id).toBe(3);
			expect(f.execId).toBe("e9");
			expect(f.shellStream).toBeDefined();
		}
		expect(seq[0].shellStream.start).toBeDefined();
		expect(seq.at(-1).shellStream.exit).toBeDefined();
		expect(seq.at(-1).shellStream.exit.code).toBe(0);
	});

	// A command that FAILED must still terminate. This is the case where it is
	// tempting to report the error and stop — and stopping is the hang.
	it("ends a failing stream with an exit frame too, carrying a non-zero code", async () => {
		const out = await handleExec(stubBridge({ bash: throwing }), streamArgs);
		expect(out).not.toBeNull();
		const seq = frames(out!);
		expect(seq.at(-1).shellStream.exit).toBeDefined();
		// 0 here would tell the model a command that threw had worked.
		expect(seq.at(-1).shellStream.exit.code).not.toBe(0);
	});

	// And the refusal path, which has no bridge to run at all.
	it("refuses a stream with a terminal exit rather than a result message", () => {
		const body = refusalFor({ shellStreamArgs: {} }, "unsupported") as any;
		expect(body.shellStream.exit).toBeDefined();
	});
});
