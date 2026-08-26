/**
 * Strip terminal escape sequences from a byte stream.
 *
 * WHY THIS IS NEEDED AT ALL. Without a pty, a command's stdout is a pipe, most
 * tools detect that and emit no colour, and pi's `OutputAccumulator` performs no
 * sanitization of its own (verified: no strip/sanitize/\x1b handling anywhere in
 * it). Today's clean tool output is therefore clean BY ACCIDENT. Give the same
 * command a pty and every one of those tools turns colour and progress bars back
 * on — so the model would start paying for escape codes it cannot read.
 *
 * STREAMING IS THE WHOLE POINT. A 64 KiB read can split anywhere, including
 * between `ESC` and `[`, or midway through an OSC string. A stateless regex over
 * each chunk would pass the tail of a split sequence through as literal garbage,
 * which is exactly the case that shows up only under load. This holds an
 * incomplete prefix instead and resumes on the next chunk.
 *
 * Pairs with `RepaintCollapser`, and the ORDER MATTERS — it is
 * strip → normalizeCRLF → collapse. See `normalizeCRLF` for why the CRLF step
 * has to come before the collapser rather than after it.
 */

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const ST_FINAL = 0x5c; // the '\' of a String Terminator (ESC \)

/** Bounds a held prefix so a stream of bare ESCs cannot grow it without limit. */
const MAX_PENDING = 4096;

type Mode =
	| "text"
	| "esc" // saw ESC, waiting on the next byte to classify
	| "csi" // ESC [ … <final 0x40-0x7e>
	| "osc" // ESC ] … (BEL | ESC \)
	| "osc-esc"; // inside OSC, saw ESC, waiting for '\'

function isCsiFinal(b: number): boolean {
	return b >= 0x40 && b <= 0x7e;
}

/**
 * Control bytes that survive stripping because they carry layout the reader
 * needs. Everything else below 0x20 is display machinery.
 *
 * `\r` is kept deliberately — the collapser downstream needs it to tell a
 * repaint from a line ending. Removing it here would silently disable repaint
 * collapsing.
 */
function isKeptControl(b: number): boolean {
	return b === 0x09 || b === 0x0a || b === 0x0d || b === 0x08;
}

export class AnsiStripper {
	private mode: Mode = "text";
	/** Raw bytes of the sequence in progress, kept only to bound memory. */
	private held = 0;

	/** Consume a chunk, returning the bytes that survive stripping. */
	write(chunk: Buffer): Buffer {
		const out = Buffer.allocUnsafe(chunk.length);
		let n = 0;

		for (const b of chunk) {
			switch (this.mode) {
				case "text":
					if (b === ESC) {
						this.mode = "esc";
						this.held = 1;
					} else if (b >= 0x20 || isKeptControl(b)) {
						out[n++] = b;
					}
					// else: a bare control byte (colour reset leftovers, NUL, vertical
					// tab). Dropped — it renders as nothing and costs context.
					break;

				case "esc":
					this.held++;
					if (b === 0x5b) this.mode = "csi"; // '['
					else if (b === 0x5d) this.mode = "osc"; // ']'
					else {
						// Two-byte escape (ESC 7, ESC =, ESC M …). Consumed whole.
						// CAN and SUB abort a sequence per ECMA-48; treat them the same
						// way — the sequence is over either way.
						this.mode = "text";
						this.held = 0;
					}
					break;

				case "csi":
					this.held++;
					if (isCsiFinal(b)) {
						this.mode = "text";
						this.held = 0;
					}
					break;

				case "osc":
					this.held++;
					if (b === BEL) {
						this.mode = "text";
						this.held = 0;
					} else if (b === ESC) {
						this.mode = "osc-esc";
					} else if (b === CAN || b === SUB) {
						this.mode = "text";
						this.held = 0;
					}
					break;

				case "osc-esc":
					this.held++;
					// ESC \ terminates; anything else was an ESC inside the string and
					// the OSC continues.
					this.mode = b === ST_FINAL ? "text" : "osc";
					if (this.mode === "text") this.held = 0;
					break;
			}

			// A sequence this long is not a sequence. Give up and resume as text
			// rather than swallow the rest of the stream.
			if (this.held > MAX_PENDING) {
				this.mode = "text";
				this.held = 0;
			}
		}

		return out.subarray(0, n);
	}

	/**
	 * Finish the stream. An escape sequence left incomplete when the process died
	 * is discarded: it painted nothing, and emitting its fragment would put raw
	 * `\x1b[` into the transcript.
	 */
	close(): Buffer {
		this.mode = "text";
		this.held = 0;
		return Buffer.alloc(0);
	}
}

/**
 * Normalize pty line endings.
 *
 * A pty in canonical mode applies ONLCR, turning every `\n` the program writes
 * into `\r\n`. Left alone, every line of a transcript would carry a stray CR
 * the model pays for and no reader wants.
 *
 * RUN THIS BEFORE THE COLLAPSER, NOT AFTER — measured, and the opposite of what
 * is intuitive. The collapser decides "repaint or line ending?" by asking
 * whether text follows the CR on that line. Under ONLCR the LAST CR of every
 * line is the CRLF one, so that guard fires on every line and NOTHING is ever
 * collapsed: a 200-frame spinner survived whole. Normalizing first disambiguates
 * completely — CRLF is unambiguously a line ending and is gone, so every CR that
 * remains is unambiguously a repaint.
 *
 * Nothing is lost by normalizing first: `\r\n` is universally a line ending, and
 * a bare `\r` (the repaint) is preserved for the collapser to act on.
 */
export function normalizeCRLF(chunk: Buffer): Buffer {
	if (chunk.indexOf(0x0d) < 0) return chunk;
	const out = Buffer.allocUnsafe(chunk.length);
	let n = 0;
	for (let i = 0; i < chunk.length; i++) {
		// Drop a CR only when it is immediately followed by LF.
		if (chunk[i] === 0x0d && chunk[i + 1] === 0x0a) continue;
		out[n++] = chunk[i]!;
	}
	return out.subarray(0, n);
}
