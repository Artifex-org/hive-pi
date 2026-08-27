/**
 * HIV-1406 sender: tool errors carry a KIND, not a message.
 *
 * This is the one place the extension reads a tool result, so these tests are
 * as much about what must NOT happen as about the counts. The privacy property
 * is not "we remembered to strip it" — it is that the only values which can
 * ever be produced are ten fixed literals, so no fragment of a result has
 * anywhere to hide.
 */

import { describe, expect, it } from "vitest";
import {
	classifyToolError,
	createRun,
	foldToolEnd,
	foldToolStart,
	toolErrorText,
	boundForClassification,
	type RunAccumulator,
} from "../extensions/hive-telemetry/accumulator.ts";
import { buildPayload } from "../extensions/hive-telemetry/payload.ts";
import type { ResolvedConfig, ToolErrorKind } from "../extensions/hive-telemetry/types.ts";

const KINDS: ToolErrorKind[] = [
	"guard_blocked",
	"not_found",
	"nonzero_exit",
	"bad_args",
	"no_match",
	"timeout",
	"permission",
	"unreachable",
	"interrupted",
	"other",
];

const CFG: ResolvedConfig = {
	enabled: true,
	url: "https://hive.example/api/v1/agent-sessions",
	flushIntervalMs: 120_000,
	eventThreshold: 25,
	spoolEveryFlush: false,
	projectOverride: null,
};

function run(): RunAccumulator {
	return createRun("run-1", "sess-1", "", "workstation", 1_770_000_000_000);
}

describe("classifyToolError", () => {
	// Real messages, in the words the tools actually use.
	it.each([
		["worktree guard: refusing to run sed -i in main", "guard_blocked"],
		["Edit is blocked in this checkout", "guard_blocked"],
		["bash: cat: /tmp/nope: No such file or directory", "not_found"],
		["ENOENT: open 'x.ts'", "not_found"],
		["command exited with exit status 2", "nonzero_exit"],
		["Error: unknown flag: --colour", "bad_args"],
		["required: missing properties: [\"run_id\"]", "bad_args"],
		["usage: git commit [-m msg]", "bad_args"],
		["operation timed out after 120s", "timeout"],
		["EACCES: permission denied, open '/etc/shadow'", "permission"],
		["the tool call was interrupted by the user", "interrupted"],
		["something nobody has ever seen before", "other"],
	])("classifies %j as %s", (message, want) => {
		expect(classifyToolError(message)).toBe(want);
	});

	// Every row below is a message that the eight-value vocabulary reported as
	// `other`, transcribed from the fleet corpus that found them. They are kept
	// verbatim (paths elided) rather than paraphrased: the whole defect was a
	// phrase list written from imagination instead of from what tools say.
	it.each([
		// The single largest bucket. pi's bash tool says "exited with code",
		// which matches neither "exit code" nor "exit status".
		["(no output)\nCommand exited with code 1", "nonzero_exit"],
		["some stdout here\nCommand exited with code 127", "nonzero_exit"],
		["Command exited with status 3", "nonzero_exit"],

		// The edit tool: 100% of its failures were `other`.
		["Could not find the exact text in /x/y.go", "no_match"],
		["Could not find edits[0] in /x/y.go. The oldText must match exactly including all whitespace", "no_match"],
		["Found 3 occurrences of the text in /x/y.go. The text must be unique.", "no_match"],
		["Found 2 occurrences of edits[1] in /x/y.go. Each oldText must be unique.", "no_match"],
		["No changes made to /x/y.go. The replacement produced identical content.", "no_match"],

		// pi's own tool-schema validator, and hive's MCP argument validator.
		['Validation failed for tool "list_symbols": - file: must have required properties file', "bad_args"],
		['Error: validating "arguments": validating root: unexpected additional properties ["limit"]', "bad_args"],
		["Expected parameters: session_id (string) *required*", "bad_args"],

		// Read-tool misuse that arrives wearing an errno.
		["Offset 900 is beyond end of file (120 lines total)", "bad_args"],
		["EISDIR: illegal operation on a directory, read", "bad_args"],

		// The network, which is neither the model's fault nor a schema problem.
		["page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/", "unreachable"],
		["connect ECONNREFUSED 127.0.0.1:8080", "unreachable"],
		["socket hang up", "unreachable"],

		// The guard's own shout.
		["BLOCKED: command operates in the main worktree of hive-pi", "guard_blocked"],
	])("classifies the previously-unexplained %j as %s", (message, want) => {
		expect(classifyToolError(message)).toBe(want);
	});

	// no_match is NOT bad_args, and the distinction is the point of the kind:
	// bad_args means the call and the tool's schema disagree, no_match means the
	// call was well-formed and the file on disk is not what the model last read.
	// They have different owners, so a rule that collapsed them would put the
	// biggest single bucket under the wrong one.
	it("keeps a stale edit anchor apart from a schema violation", () => {
		expect(classifyToolError("Could not find the exact text in /x/y.go")).toBe("no_match");
		expect(classifyToolError('Validation failed for tool "edit": - edits.0.newText: must have required properties newText')).toBe("bad_args");
	});

	// The no_match phrases are matched specifically, not by a generic "found N
	// occurrences", because unrelated tool output quotes that shape constantly.
	it("does not claim unrelated output that happens to count occurrences", () => {
		expect(classifyToolError("grep: found 3 occurrences in the log\nCommand exited with code 0")).not.toBe("no_match");
	});

	it("returns a kind from the fixed vocabulary for ANY input", () => {
		// Including inputs designed to look like they carry data worth keeping.
		for (const input of [
			undefined,
			"",
			"/home/dev/secrets/api-key.txt contains gho_deadbeef",
			"SELECT * FROM users WHERE email = 'someone@example.com'",
			"x".repeat(50_000),
			JSON.stringify({ token: "sk-live-123", path: "/srv/prod/.env" }),
		]) {
			const kind = classifyToolError(input);
			expect(KINDS).toContain(kind);
		}
	});

	// The property that makes the exception defensible: the output is drawn
	// from a closed set, so it cannot carry a substring of the input. A
	// classifier that ever returned part of its argument would fail here.
	it("never returns any fragment of its input", () => {
		const secret = "gho_supersecrettoken";
		const kind = classifyToolError(`permission denied writing ${secret} to /etc/passwd`);
		expect(kind).toBe("permission");
		expect(kind).not.toContain(secret);
		expect(kind).not.toContain("/etc");
		expect(KINDS).toContain(kind);
	});

	// Ordering is load-bearing: these phrases co-occur constantly, and the
	// first match should be the one that names the remedy.
	it("prefers the actionable cause when causes overlap", () => {
		expect(classifyToolError("worktree guard: permission denied, refusing to write")).toBe("guard_blocked");
		expect(classifyToolError("invalid argument --foo (exit status 1)")).toBe("bad_args");
	});
});

describe("toolErrorText", () => {
	it("reads the common result shapes", () => {
		expect(toolErrorText("plain")).toBe("plain");
		expect(toolErrorText(new Error("boom"))).toBe("boom");
		expect(toolErrorText({ message: "m" })).toBe("m");
		expect(toolErrorText({ stderr: "e" })).toBe("e");
		expect(toolErrorText({ content: "c" })).toBe("c");
	});

	it("reads the actual Pi content-block envelope without retaining details", () => {
		const result = {
			content: [{ type: "text", text: "Error: required parameter 'run_id' is missing" }],
			details: { secret: "must not be read" },
		};
		expect(classifyToolError(toolErrorText(result))).toBe("bad_args");
	});

	it("returns undefined rather than stringifying an unknown shape", () => {
		// Stringifying would drag arbitrary object contents into the classifier
		// for no benefit — the eight substrings live in message-like fields.
		expect(toolErrorText(undefined)).toBeUndefined();
		expect(toolErrorText(null)).toBeUndefined();
		expect(toolErrorText(42)).toBeUndefined();
		expect(toolErrorText({ rows: [1, 2, 3] })).toBeUndefined();
	});

	it("bounds a result that is an entire file", () => {
		const text = toolErrorText("y".repeat(100_000));
		// One extra character: the newline joining the two halves.
		expect(text?.length).toBe(2049);
	});

	// The reason the window is head+tail and not head. A shell result puts its
	// diagnostic on the LAST line, after however much stdout came first, so a
	// head-only bound threw the classifiable sentence away on exactly the
	// results too large to read. 134 of the 191 oversized errors in the corpus
	// were classifiable only in the tail — all of them bash, all of them
	// reported as `other`.
	it("classifies a huge bash result whose verdict is on the last line", () => {
		const noisy = `${"log line\n".repeat(5_000)}Command exited with code 2`;
		expect(noisy.length).toBeGreaterThan(2048);
		expect(classifyToolError(toolErrorText(noisy))).toBe("nonzero_exit");
	});

	it("still classifies when the verdict is at the front", () => {
		const noisy = `Command exited with code 2\n${"log line\n".repeat(5_000)}`;
		expect(classifyToolError(toolErrorText(noisy))).toBe("nonzero_exit");
	});
});

describe("boundForClassification", () => {
	it("leaves anything within budget untouched", () => {
		expect(boundForClassification("short", 2048)).toBe("short");
		expect(boundForClassification("x".repeat(2048), 2048)).toBe("x".repeat(2048));
	});

	it("keeps both ends and drops the middle, within the same budget", () => {
		const text = `HEAD${"m".repeat(10_000)}TAIL`;
		const out = boundForClassification(text, 100);
		expect(out.startsWith("HEAD")).toBe(true);
		expect(out.endsWith("TAIL")).toBe(true);
		// Budget plus the single joining newline, never more.
		expect(out.length).toBe(101);
		expect(out).not.toContain("m".repeat(60));
	});

	it("joins with a bare newline — no marker, no byte count", () => {
		// A separator would be a substring the rules could match by accident,
		// and a byte count would be a fact about the payload surviving into a
		// value that is supposed to carry none.
		const out = boundForClassification("a".repeat(5_000), 100);
		expect(out).toBe(`${"a".repeat(50)}\n${"a".repeat(50)}`);
		expect(out).not.toMatch(/\.\.\.|truncat|elided|bytes|chars/i);
	});
});

describe("foldToolEnd error kinds", () => {
	it("counts kinds per tool, and only for failures", () => {
		const a = run();
		foldToolStart(a, "c1", "bash");
		foldToolEnd(a, "c1", "bash", true, "guard_blocked");
		foldToolStart(a, "c2", "bash");
		foldToolEnd(a, "c2", "bash", true, "guard_blocked");
		foldToolStart(a, "c3", "bash");
		foldToolEnd(a, "c3", "bash", true, "not_found");
		foldToolStart(a, "c4", "bash");
		foldToolEnd(a, "c4", "bash", false);

		const bucket = a.tools.get("bash");
		expect(bucket?.calls).toBe(4);
		expect(bucket?.errors).toBe(3);
		expect(bucket?.errorKinds?.get("guard_blocked")).toBe(2);
		expect(bucket?.errorKinds?.get("not_found")).toBe(1);
	});

	// Absent must not become all-zero: on the server a NULL means NOT REPORTED,
	// which its report deliberately keeps distinct from "reported, none".
	it("creates no map at all for a tool that never errored", () => {
		const a = run();
		foldToolEnd(a, "c1", "read", false);
		expect(a.tools.get("read")?.errorKinds).toBeUndefined();
	});

	it("defaults to `other` when the caller classified nothing", () => {
		const a = run();
		foldToolEnd(a, "c1", "read", true);
		expect(a.tools.get("read")?.errorKinds?.get("other")).toBe(1);
	});
});

describe("payload boundary", () => {
	function payloadFor(a: RunAccumulator) {
		return buildPayload(a, CFG, "0.84.1", 1_770_000_100_000) as unknown as {
			tools: { tool_name: string; calls: number; errors: number; error_kinds?: Record<string, number> }[];
		};
	}

	it("emits error_kinds only for tools that errored", () => {
		const a = run();
		foldToolEnd(a, "c1", "bash", true, "guard_blocked");
		foldToolEnd(a, "c2", "read", false);

		const tools = payloadFor(a).tools;
		const bash = tools.find((t) => t.tool_name === "bash");
		const read = tools.find((t) => t.tool_name === "read");
		expect(bash?.error_kinds).toEqual({ guard_blocked: 1 });
		// Omitted, not `{}` — the key must be absent from the wire object.
		expect(read && "error_kinds" in read).toBe(false);
	});

	// The counts and their total have to agree, or a reader has no reason to
	// trust either. `errors` is clamped to `calls` server-side, so the kinds
	// must be clamped to the same figure.
	it("never lets the kind counts exceed the tool's reported errors", () => {
		const a = run();
		for (let i = 0; i < 5; i++) foldToolEnd(a, `c${i}`, "bash", true, "nonzero_exit");
		// Force the inconsistency the clamp exists to absorb.
		const bucket = a.tools.get("bash");
		if (bucket) bucket.errors = 2;

		const bash = payloadFor(a).tools.find((t) => t.tool_name === "bash");
		const total = Object.values(bash?.error_kinds ?? {}).reduce((s, n) => s + n, 0);
		expect(total).toBeLessThanOrEqual(bash?.errors ?? 0);
	});

	it("sends only vocabulary keys, never free text", () => {
		const a = run();
		foldToolEnd(a, "c1", "bash", true, classifyToolError("EACCES: permission denied for /srv/prod/.env"));
		const bash = payloadFor(a).tools.find((t) => t.tool_name === "bash");
		for (const key of Object.keys(bash?.error_kinds ?? {})) {
			expect(KINDS).toContain(key as ToolErrorKind);
		}
		expect(JSON.stringify(bash)).not.toContain("/srv");
	});
});
