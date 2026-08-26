/**
 * Turning a stream of chunks into whole JSON lines.
 *
 * Trivial-looking and load-bearing: a child's stdout arrives in arbitrary
 * chunks, so a JSON object is routinely SPLIT across two `data` events. Handling
 * a chunk without carrying the remainder silently drops whichever event
 * straddled the boundary — and because the dropped line is usually a
 * `message_end`, the visible symptom is a worker that "produced no output" or
 * one whose spend is understated, never a parse error.
 *
 * It lived in `agenda/rpc-protocol.ts` (with a test named for the loss it
 * prevents) while `subagent/index.ts` hand-rolled the same three lines inline
 * and untested. One copy now, since a framing bug in one of two copies is
 * indistinguishable from a flaky worker.
 *
 * Nothing mutable at module scope — the caller owns the buffer, which is what
 * makes this pure and testable without a child process.
 */

/**
 * Split `buffer + chunk` into complete lines plus the unterminated remainder.
 *
 * The caller MUST feed `rest` back in as the next call's `buffer`; that is the
 * whole mechanism. A trailing fragment is never returned as a line, so a partial
 * object is never handed to `JSON.parse`.
 */
export function frame(buffer: string, chunk: string): { lines: string[]; rest: string } {
	const combined = buffer + chunk;
	const parts = combined.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts, rest };
}
