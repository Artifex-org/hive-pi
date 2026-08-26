/**
 * Drop terminal output that was overwritten in place before anyone could read it.
 *
 * A PORT of hive's `cmd/hive-agent/workstation_logrepaint.go`. That file is Go
 * in `package main` inside `cmd/hive-agent`, so it cannot be imported and is not
 * worth extracting into a shared package for one TypeScript consumer. The Go
 * tests are ported alongside it (`test/pty-repaint.test.ts`) so a divergence
 * between the two implementations fails an assertion instead of showing up as a
 * silent difference between the tmux capture and the model's tool result.
 *
 * WHY IT EXISTS. A pty stream is raw TTY bytes, and pi's spinner repaints its
 * status line ~10x/second: each frame is `\r\x1b[2K` followed by ~180 bytes of
 * colour codes and the word "Working...". Measured on hive's own agent logs,
 * that filled an entire 4 MiB bounded capture with roughly ninety seconds of
 * spinner. Under a PTY the same thing would fill the model's context.
 *
 * The rule is the terminal's own: a carriage return with no newline sends the
 * cursor back to column 0, so whatever preceded it on that line is about to be
 * painted over and was never durable content. Only the LAST state of an
 * in-place-updated line survives, which is the one an operator would have seen.
 * Newline-terminated output — every command, error and stack trace — passes
 * through untouched.
 */

/**
 * Bounds the in-progress segment. A TUI that draws a whole screen between
 * newlines is normal, so this is generous; it exists only so a process emitting
 * megabytes with neither \r nor \n cannot hold them in memory.
 */
export const REPAINT_FLUSH_BYTES = 64 << 10;

const CR = 0x0d;
const LF = 0x0a;

/**
 * Keep, for each newline-terminated line, only the text after its last carriage
 * return.
 *
 * A bare \r inside a line means the rest of that line overwrote it. A trailing
 * \r\n is NOT a repaint — it is a CRLF line ending — so the \r is only honoured
 * when text follows it on the same line. That distinction is load-bearing here
 * in a way it is not in the Go original: a pty turns every \n into \r\n (ONLCR),
 * so treating a trailing CR as a repaint would delete every line of output.
 */
export function collapseCarriageReturns(input: Buffer): Buffer {
	if (input.indexOf(CR) < 0) return input;

	const out: Buffer[] = [];
	let b = input;
	while (b.length > 0) {
		let i = b.indexOf(LF);
		if (i < 0) i = b.length - 1;
		let line = b.subarray(0, i + 1);
		b = b.subarray(i + 1);

		const r = line.lastIndexOf(CR);
		// `r < line.length - 2` is the CRLF guard: at length-2 the \r is followed
		// only by \n, which is a line ending rather than something painted over.
		if (r >= 0 && r < line.length - 2) line = line.subarray(r + 1);
		out.push(line);
	}
	return Buffer.concat(out);
}

/**
 * Streaming collapser. Feed it chunks; it forwards durable output and holds
 * whatever might still be overwritten.
 */
export class RepaintCollapser {
	private pending: Buffer = Buffer.alloc(0);

	constructor(private readonly out: (chunk: Buffer) => void) {}

	/**
	 * Consume a chunk of the TTY stream.
	 *
	 * Everything up to and including the final newline is durable and forwarded
	 * as one write. The remainder is held: it is either a line still being typed
	 * or a repaint frame about to be discarded, and only the next bytes decide
	 * which.
	 */
	write(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

		const i = this.pending.lastIndexOf(LF);
		if (i >= 0) {
			// Collapse repaints WITHIN the durable span too: a chunk can carry many
			// spinner frames and then a real line, and every frame before the last
			// \r on a given line was overwritten.
			this.out(collapseCarriageReturns(this.pending.subarray(0, i + 1)));
			this.pending = Buffer.from(this.pending.subarray(i + 1));
		}

		// Keep only the newest repaint of an unterminated line.
		const r = this.pending.lastIndexOf(CR);
		if (r >= 0) this.pending = Buffer.from(this.pending.subarray(r + 1));

		if (this.pending.length >= REPAINT_FLUSH_BYTES) {
			this.out(this.pending);
			this.pending = Buffer.alloc(0);
		}
	}

	/**
	 * Flush the final unterminated segment.
	 *
	 * This is the single most valuable line in a post-mortem — a command killed
	 * mid-run leaves its last frame here and nowhere else — so it is written even
	 * though no newline ever arrived to make it durable.
	 */
	close(): void {
		if (this.pending.length === 0) return;
		const pending = this.pending;
		this.pending = Buffer.alloc(0);
		this.out(pending);
	}
}
