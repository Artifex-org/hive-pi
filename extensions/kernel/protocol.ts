/**
 * The kernel wire protocol and output shaping — the pure half.
 *
 * Everything here decides *what a frame is*, *what one execution amounts to*
 * and *how much of it the model is allowed to see*. No process, no fs, no `pi`.
 * `session.ts` owns the subprocess and `index.ts` owns the tool; this owns the
 * rules, and it is the half worth testing because it is the half that is wrong
 * in interesting ways.
 *
 * ## Why NDJSON over stdin/stdout and nothing else
 *
 * Jupyter's own transport is ZeroMQ over unix sockets, and a unix socket is
 * exactly what cannot be used here: srt's seccomp filter blocks
 * `socket(AF_UNIX)`. That is measured, not theorised — it is what killed
 * `@playwright/mcp` in this harness (HIV-1636), and `devservices/pg.ts` carries
 * the same scar (`unix_socket_directories=''` or Postgres will not start). A
 * plain pipe to a plain `python -u runner.py` needs no syscall the sandbox
 * denies, so the transport is one JSON object per line in each direction.
 *
 * ## The rule that shapes the file: a stray byte must never wedge the session
 *
 * The runner wraps the user's `sys.stdout`, so ordinary `print` comes back as a
 * typed frame. But a cell is allowed to run `subprocess.Popen`, and a child
 * that inherits fd 1 writes raw bytes straight into the frame stream. There is
 * no way to prevent that without giving up `!cmd` and `%%bash`, which are the
 * magics that make the kernel usable at all.
 *
 * So an unparseable line is NOT an error: it is stdout that lost its envelope,
 * and `parseFrame` says so. The rejected alternative — throwing, or dropping the
 * line — turns one badly-behaved subprocess into a kernel that answers nothing
 * for the rest of the session, which is a far worse failure than a slightly
 * mislabelled line of output.
 *
 * The same reasoning runs the other way: a cell that prints a JSON object which
 * *looks* like a frame must not be able to forge one. Hence `matchesRequest` —
 * a frame counts only when its `id` is the id of the request in flight.
 *
 * ## Tail, not head
 *
 * The preview keeps the END of the output. A traceback prints last, a summary
 * prints last, and the value of the final expression is appended last. Keeping
 * the head would reliably discard the only part anybody wanted — the same
 * conclusion `background/jobs.ts` reached for job output, for the same reason.
 *
 * Nothing mutable at module scope: pi builds a fresh jiti instance per extension
 * with `moduleCache: false`, so shared state here would silently never sync.
 */

/** Frame kinds the runner may emit. Anything else is treated as stray output. */
export const FRAME_TYPES = ["started", "stdout", "stderr", "result", "error", "done"] as const;

export type FrameType = (typeof FRAME_TYPES)[number];

/**
 * How an execution ended.
 *
 * `cancelled` and `crashed` are kept apart from `error` deliberately, and the
 * distinction is the same one `background/jobs.ts` makes: `error` is the code's
 * own verdict and is usually about the code, while `cancelled` is our timeout or
 * the human's abort and `crashed` is the interpreter dying. Collapsing them
 * would send the model debugging a phantom — a cell that was stopped at its time
 * limit looks, in a boolean world, exactly like a cell that raised.
 */
export type ExecStatus = "ok" | "error" | "cancelled" | "crashed";

export interface Frame {
	type: FrameType;
	/** The request id this frame belongs to. Frames for other ids are stray. */
	id: string;
	/** Text payload for stdout/stderr/result/error frames. */
	text: string;
	/** The runner's execution counter, on `started` and `done`. */
	count?: number;
	/** Terminal status, on `done`. */
	status?: ExecStatus;
}

export interface KernelRequest {
	id: string;
	code: string;
	/** Wall-clock limit in SECONDS — the unit the runner reads. */
	timeout: number;
}

// The one import this pure module takes: a CONSTANT, so the preview size on
// both sides of the kernel/artifacts seam is a single number (see below).
import { PREVIEW_BYTES as STORE_PREVIEW_BYTES } from "../artifacts/store.ts";

/** Default wall clock for one cell. Long enough for a real script, short
 *  enough that a hung cell does not eat the turn. */
export const DEFAULT_TIMEOUT_S = 30;
export const MIN_TIMEOUT_S = 1;
export const MAX_TIMEOUT_S = 3600;

/** Lines of output the model is shown before the rest becomes an artifact. */
export const PREVIEW_LINES = 10;
/** Longest single line shown. A one-line 40KB pandas repr is the case this
 *  exists for: it is not informative and it is not cheap. */
export const PREVIEW_LINE_CHARS = 200;
/**
 * Byte ceiling on the preview, independent of the line count — 300 short lines
 * are still 300 lines of context.
 *
 * Named `KERNEL_PREVIEW_BYTES`, not `PREVIEW_BYTES`, because the artifact store
 * exports a constant of that name with a DIFFERENT value (2048 vs the 2000 this
 * used to be), and both READMEs called their number "2KB". Two same-named
 * constants either side of a seam is a trap for whoever later notices the
 * duplication and "tidies" it by importing the other one — a silent behaviour
 * change with no test to catch it. It now takes its value FROM the store, so
 * there is one number and the kernel's preview cannot drift from what the
 * store's own spill considers preview-sized.
 */
export const KERNEL_PREVIEW_BYTES = STORE_PREVIEW_BYTES;

/** Clamp a caller-supplied timeout into the allowed band. */
export function resolveTimeoutSeconds(seconds: number | undefined): number {
	if (seconds === undefined || !Number.isFinite(seconds)) return DEFAULT_TIMEOUT_S;
	return Math.min(Math.max(Math.round(seconds), MIN_TIMEOUT_S), MAX_TIMEOUT_S);
}

export function encodeRequest(request: KernelRequest): string {
	return `${JSON.stringify(request)}\n`;
}

/**
 * Split a growing byte buffer into complete lines plus the partial remainder.
 *
 * Pipes deliver arbitrary chunks, not lines: a 40KB frame arrives in pieces and
 * two small frames arrive together. Keeping the remainder is what makes the
 * reader correct rather than usually-correct — the bug it prevents is a frame
 * silently truncated at a 64KB pipe boundary, which shows up as a kernel that
 * "sometimes" loses the last line of a big result.
 */
export function splitFrames(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts, rest };
}

/**
 * Parse one line into a frame. NEVER throws, NEVER returns null for content.
 *
 * A line that is not a well-formed frame is returned as a `stdout` frame with an
 * empty id, which `matchesRequest` then classifies as stray. See the header: a
 * subprocess writing to the inherited fd 1 is a legitimate thing for a cell to
 * do, and the kernel has to survive it.
 */
export function parseFrame(line: string): Frame | null {
	if (line.trim() === "") return null;
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return { type: "stdout", id: "", text: line };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { type: "stdout", id: "", text: line };
	}
	const record = raw as Record<string, unknown>;
	const type = record.type;
	if (typeof type !== "string" || !(FRAME_TYPES as readonly string[]).includes(type)) {
		return { type: "stdout", id: "", text: line };
	}
	return {
		type: type as FrameType,
		id: typeof record.id === "string" ? record.id : "",
		text: typeof record.text === "string" ? record.text : "",
		count: typeof record.count === "number" ? record.count : undefined,
		status: isStatus(record.status) ? record.status : undefined,
	};
}

function isStatus(value: unknown): value is ExecStatus {
	return value === "ok" || value === "error" || value === "cancelled" || value === "crashed";
}

/**
 * Does this frame belong to the request in flight?
 *
 * The id check is the anti-forgery rule. A cell may print anything, including a
 * convincing `{"type":"done","status":"ok"}`; without this, one such print would
 * end the execution early and the real output would be attributed to whatever
 * ran next. Stray frames are not discarded — they are folded in as output, which
 * is what they actually are.
 */
export function matchesRequest(frame: Frame, requestId: string): boolean {
	return frame.id === requestId;
}

export interface Execution {
	requestId: string;
	count: number;
	status: ExecStatus;
	stdout: string;
	stderr: string;
	/** repr() of the cell's final expression, when it had one. */
	result: string;
	/** The traceback, when the cell raised. */
	error: string;
	/** True once a matching `done` frame arrived. */
	done: boolean;
}

export function emptyExecution(requestId: string): Execution {
	return { requestId, count: 0, status: "ok", stdout: "", stderr: "", result: "", error: "", done: false };
}

/**
 * Fold one frame into the running execution. Pure: returns a new record.
 *
 * Returning a new object rather than mutating keeps a caller from accidentally
 * sharing one record between the live reader and a rendered view — the same
 * discipline `appendOutput` uses in `background/jobs.ts`.
 */
export function applyFrame(exec: Execution, frame: Frame): Execution {
	// Stray output — an unwrapped subprocess write, or a frame for a request
	// that is no longer in flight. It is still output; label it as such.
	if (!matchesRequest(frame, exec.requestId)) {
		return { ...exec, stdout: exec.stdout + frame.text + "\n" };
	}
	switch (frame.type) {
		case "started":
			return { ...exec, count: frame.count ?? exec.count };
		case "stdout":
			return { ...exec, stdout: exec.stdout + frame.text };
		case "stderr":
			return { ...exec, stderr: exec.stderr + frame.text };
		case "result":
			return { ...exec, result: frame.text };
		case "error":
			return { ...exec, error: exec.error + frame.text };
		case "done":
			return {
				...exec,
				done: true,
				count: frame.count ?? exec.count,
				status: frame.status ?? exec.status,
			};
	}
}

/**
 * The full text of one execution, before any shaping.
 *
 * Order is chronological-ish on purpose: what the cell printed, then what it
 * complained about, then how it ended. The traceback goes LAST so that the tail
 * preview — which is what the model actually reads — is guaranteed to contain
 * it. A shaped preview that showed the first ten lines of a 400-line print and
 * omitted the exception would be the single most misleading thing this extension
 * could return.
 */
export function renderBody(exec: Execution): string {
	const parts: string[] = [];
	if (exec.stdout.trim()) parts.push(exec.stdout.replace(/\n+$/, ""));
	if (exec.stderr.trim()) parts.push(`[stderr]\n${exec.stderr.replace(/\n+$/, "")}`);
	if (exec.result.trim()) parts.push(`[result] ${exec.result}`);
	if (exec.error.trim()) parts.push(exec.error.replace(/\n+$/, ""));
	return parts.join("\n");
}

export interface Shaped {
	/** What the model sees. */
	preview: string;
	/** True when the preview IS the whole body — no artifact is needed. */
	complete: boolean;
	/** Lines dropped from the FRONT. Reported, never silent. */
	omittedLines: number;
}

/**
 * Cut a body down to what is worth spending context on.
 *
 * This is the feature, not a nicety. The entire token argument for a persistent
 * kernel is that intermediate results stay OUT of the transcript: the agent
 * computes in the kernel and reads a summary. Return the full output and the
 * kernel becomes an expensive way to do what `bash` already did — every
 * dataframe, every log line, every loop's chatter billed to the context window
 * on the way past.
 *
 * Three independent limits, because they fail differently: too many lines (a
 * loop printing), too many characters on one line (a repr), too many bytes
 * overall (many short lines). Any one of them being exceeded means the rest
 * belongs in an artifact.
 */
export function shapeOutput(
	body: string,
	opts: { maxLines?: number; maxLineChars?: number; maxBytes?: number } = {},
): Shaped {
	const maxLines = opts.maxLines ?? PREVIEW_LINES;
	const maxLineChars = opts.maxLineChars ?? PREVIEW_LINE_CHARS;
	const maxBytes = opts.maxBytes ?? KERNEL_PREVIEW_BYTES;

	if (body === "") return { preview: "", complete: true, omittedLines: 0 };

	const lines = body.split("\n");
	const kept = lines.slice(Math.max(0, lines.length - maxLines));
	const omittedLines = lines.length - kept.length;

	let clampedAny = false;
	const clamped = kept.map((line) => {
		if (line.length <= maxLineChars) return line;
		clampedAny = true;
		return `${line.slice(0, maxLineChars)}… (+${line.length - maxLineChars} chars)`;
	});

	let preview = clamped.join("\n");
	let bytesDropped = false;
	if (preview.length > maxBytes) {
		// Byte-trim from the front, for the same tail-not-head reason.
		preview = preview.slice(preview.length - maxBytes);
		bytesDropped = true;
	}

	return { preview, complete: omittedLines === 0 && !clampedAny && !bytesDropped, omittedLines };
}

/**
 * The text the tool returns, given a shaped preview and (when the output did not
 * fit) the artifact it was spilled to.
 *
 * The truncation notice is not decoration. A model told its output is complete
 * when it is not will confidently reason from the visible tail; a model told
 * where the rest is will go and get it. `background/jobs.ts` records the same
 * finding for its completion notifications, and the fix is the same one word:
 * say so.
 */
export function renderToolText(input: {
	exec: Execution;
	shaped: Shaped;
	/** `artifact://<id>`, or null when the preview is the whole body. */
	ref: string | null;
	/** Concrete path of the artifact, so `read` works without the artifacts tool. */
	artifactPath?: string | null;
	interpreter: string;
	cwd: string;
	/** Set on the first execution of a freshly spawned kernel. */
	spawned?: boolean;
}): string {
	const { exec, shaped, ref, artifactPath, interpreter, cwd, spawned } = input;
	const head =
		`[${exec.count}] ${statusLabel(exec.status)}` +
		(spawned ? ` — new kernel (${interpreter}) in ${cwd}` : "");

	const lines: string[] = [head];
	if (shaped.preview) {
		lines.push("", shaped.preview);
	} else {
		lines.push("", "(no output)");
	}

	// The notice is driven by `shaped.complete`, NOT by whether an artifact was
	// written. `spill` legitimately returns `ref: null` when the session's
	// artifact store is full or the write failed, and the catch in `index.ts`
	// adds a third such path — in all of them the preview is still partial. A
	// notice gated on the ref would go silent in exactly those cases, leaving the
	// model to reason confidently from a tail it believes is the whole answer.
	// That is the worst output this extension can produce, so it is the one thing
	// here that is unconditional.
	if (!shaped.complete) {
		lines.push(
			"",
			`Output truncated — ${shaped.omittedLines} earlier line(s) omitted. ` +
				(ref
					? `Full output: ${ref}${artifactPath ? ` (${artifactPath})` : ""}. Read it with artifact_read — but ` +
						"prefer narrowing it down with another cell, which is cheaper and is why the data is still " +
						"in the kernel."
					: "The rest could NOT be stored (artifact unavailable) and is gone — re-run with the output " +
						"narrowed down in the cell itself."),
		);
	}

	if (exec.status === "cancelled") {
		lines.push(
			"",
			"The cell was interrupted at its time limit. Variables set before the interrupt are still in the " +
				"kernel; re-run only the part that did not finish, or raise `timeout_seconds`.",
		);
	}
	if (exec.status === "crashed") {
		lines.push(
			"",
			"The interpreter died — all kernel state is gone. The next call starts a fresh kernel; anything " +
				"you had in variables must be recomputed.",
		);
	}
	return lines.join("\n");
}

function statusLabel(status: ExecStatus): string {
	switch (status) {
		case "ok":
			return "ok";
		case "error":
			return "raised";
		case "cancelled":
			return "interrupted (timeout)";
		case "crashed":
			return "kernel crashed";
	}
}
