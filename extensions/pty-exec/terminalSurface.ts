/**
 * Publish the terminal an agent's commands run on, and accept a human's
 * keystrokes back.
 *
 * Modelled on `extensions/browser/surface.ts` and reusing its shapes wherever
 * they carry: the FIFO pair, NDJSON framing, the manifest, and the
 * lease-plus-generation check that decides whether an inbound command is
 * allowed. Where this diverges it is because terminal bytes are not screenshots.
 *
 * THE ONE DIVERGENCE THAT MATTERS — BACKPRESSURE. The browser bridge is a
 * single-slot LATEST-VALUE queue: when the pipe is full it drops the older
 * frame, because a newer picture supersedes an older one. Terminal bytes have
 * no such property. Dropping a chunk in the middle of a stream corrupts
 * everything after it, and the reader cannot tell that it happened. So this
 * buffers, and when the buffer is genuinely exhausted it drops WHOLE FRAMES from
 * the front and says so with a `gap` frame — a viewer can render "N bytes lost"
 * but cannot recover from silent truncation.
 *
 * KEYSTROKES NEVER REACH HIVE. They arrive on the local control FIFO and go
 * straight to the pty. They are not transcript events, not SSE frames, and not
 * part of the tool result — a passphrase must not become a durable row.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { terminalSurfaceConfig, type TerminalSurfaceConfig } from "../hive-common/terminalSurface.ts";

export { terminalSurfaceConfig } from "../hive-common/terminalSurface.ts";

const CONTROL_POLL_MS = 50;
const MAX_CONTROL_LINE_BYTES = 16 << 10;
/** Decoded stdin per command, matching the desktop validator's encoded cap. */
const MAX_STDIN_BYTES = 16 << 10;
/**
 * How much unwritten output to hold when nobody is draining the pipe. Past this
 * the oldest frames go, which is a visible gap rather than a silent corruption.
 */
const MAX_PENDING_BYTES = 256 << 10;

export interface SurfaceLease {
	id: string;
	generation: number;
	expires_at: number;
}

export interface TerminalCommand {
	id: string;
	lease_id: string;
	generation: number;
	kind: "stdin" | "resize";
	/** base64, for `stdin`. Encoded so a keystroke cannot break the NDJSON line. */
	data?: string;
	rows?: number;
	cols?: number;
}

function atomicWrite(file: string, data: string | Buffer): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function readLease(config: Pick<TerminalSurfaceConfig, "lease">): SurfaceLease | null {
	try {
		const stat = fs.lstatSync(config.lease);
		// Group/world-accessible, or a symlink, means someone else could have
		// written it — and the lease is what authorises typing into this terminal.
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
		const value = JSON.parse(fs.readFileSync(config.lease, "utf8")) as Partial<SurfaceLease>;
		if (
			typeof value.id !== "string" ||
			value.id.length < 16 ||
			value.id.length > 128 ||
			!Number.isInteger(value.generation) ||
			typeof value.expires_at !== "number"
		) {
			return null;
		}
		return value as SurfaceLease;
	} catch {
		return null;
	}
}

/** Is this a base64 string, and how many bytes does it decode to? */
function decodedBase64(data: string): Buffer | null {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
	try {
		const buf = Buffer.from(data, "base64");
		// Round-trip: Buffer.from is lenient and silently drops invalid input, so
		// a string that does not re-encode to itself was not really base64.
		if (buf.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) return null;
		return buf;
	} catch {
		return null;
	}
}

/**
 * A closed allowlist, mirroring the desktop side's validator.
 *
 * Both ends validate. The desktop check stops a malformed command leaving the
 * app; this one is the boundary that actually matters, because the FIFO is a
 * file any process running as this user could write to.
 */
export function validateTerminalCommand(
	raw: unknown,
	lease: SurfaceLease | null,
	now = Date.now(),
): TerminalCommand | null {
	if (!raw || typeof raw !== "object" || !lease || lease.expires_at <= now) return null;
	const command = raw as Partial<TerminalCommand>;
	if (
		typeof command.id !== "string" ||
		command.id.length < 1 ||
		command.id.length > 128 ||
		command.lease_id !== lease.id ||
		command.generation !== lease.generation
	) {
		return null;
	}
	if (command.kind === "stdin") {
		if (typeof command.data !== "string") return null;
		const decoded = decodedBase64(command.data);
		if (!decoded || decoded.length === 0 || decoded.length > MAX_STDIN_BYTES) return null;
		return command as TerminalCommand;
	}
	if (command.kind === "resize") {
		for (const v of [command.rows, command.cols]) {
			if (!Number.isInteger(v) || Number(v) < 1 || Number(v) > 512) return null;
		}
		return command as TerminalCommand;
	}
	return null;
}

/**
 * One launch's terminal bridge. Lives for the session, not for one command:
 * commands come and go and the human's attachment should survive them.
 */
export class TerminalSurfaceBridge {
	private frameFD = -1;
	private controlFD = -1;
	private controlBuffer = "";
	private controlTimer: NodeJS.Timeout | null = null;
	/** Frames awaiting the pipe, oldest first. Byte-lossless until it overflows. */
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private pendingOffset = 0;
	private droppedBytes = 0;
	private sequence = 0;
	private rows = 50;
	private cols = 200;
	private stopped = false;
	private inputHandler: ((data: Buffer) => void) | null = null;
	private resizeHandler: ((rows: number, cols: number) => void) | null = null;
	private readonly publisherID = randomUUID();
	private readonly publisherStartedAt = Date.now();

	private constructor(private readonly config: TerminalSurfaceConfig) {}

	static start(env: NodeJS.ProcessEnv = process.env): TerminalSurfaceBridge | null {
		const config = terminalSurfaceConfig(env);
		if (!config) return null;
		const bridge = new TerminalSurfaceBridge(config);
		bridge.writeManifest("ready");
		bridge.controlTimer = setInterval(() => bridge.pollControls(), CONTROL_POLL_MS);
		bridge.controlTimer.unref?.();
		return bridge;
	}

	onInput(handler: (data: Buffer) => void): void {
		this.inputHandler = handler;
	}

	onResize(handler: (rows: number, cols: number) => void): void {
		this.resizeHandler = handler;
	}

	/** True while a human holds an unexpired lease — suppresses the auto-EOF. */
	hasLease(now = Date.now()): boolean {
		const lease = readLease(this.config);
		return lease !== null && lease.expires_at > now;
	}

	geometry(): { rows: number; cols: number } {
		return { rows: this.rows, cols: this.cols };
	}

	/** Raw pty bytes, exactly as the terminal produced them. */
	writeOutput(chunk: Buffer): void {
		if (this.stopped || chunk.length === 0) return;
		this.writeFrame({
			type: "output",
			sequence: this.sequence++,
			publisher_id: this.publisherID,
			publisher_started_at: this.publisherStartedAt,
			encoding: "base64",
			data: chunk.toString("base64"),
		});
	}

	beginCommand(callID: string, command: string, cwd: string): void {
		this.writeFrame({
			type: "begin",
			sequence: this.sequence++,
			call_id: callID,
			command: command.slice(0, 4096),
			cwd,
			rows: this.rows,
			cols: this.cols,
		});
	}

	endCommand(callID: string, exitCode: number | null): void {
		this.writeFrame({ type: "end", sequence: this.sequence++, call_id: callID, exit_code: exitCode });
	}

	private writeManifest(state: "ready" | "ended" | "error"): void {
		try {
			atomicWrite(
				this.config.manifest,
				JSON.stringify({
					version: 1,
					kind: "terminal",
					state,
					launch_id: this.config.launchID,
					pid: process.pid,
					publisher_id: this.publisherID,
					publisher_started_at: this.publisherStartedAt,
					frame_fifo: "frames.fifo",
					control_fifo: "control.fifo",
					rows: this.rows,
					cols: this.cols,
					updated_at: Date.now(),
				}),
			);
		} catch {
			/* the directory may be gone during teardown */
		}
	}

	private openFrameWriter(): number {
		if (this.frameFD >= 0) return this.frameFD;
		try {
			this.frameFD = fs.openSync(this.config.frameFIFO, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
		} catch {
			// ENXIO: no reader attached. Normal — nobody is watching yet.
			this.frameFD = -1;
		}
		return this.frameFD;
	}

	private writeFrame(message: unknown): void {
		const line = Buffer.from(`${JSON.stringify(message)}\n`);
		this.pending.push(line);
		this.pendingBytes += line.length;
		this.trimPending();
		this.flushFrames();
	}

	/**
	 * Enforce the buffer ceiling by dropping WHOLE oldest frames.
	 *
	 * Whole frames, never partial ones: half a line is malformed JSON that would
	 * desynchronise the reader permanently. Never the frame currently being
	 * written either — its first bytes are already in the pipe.
	 */
	private trimPending(): void {
		while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
			const dropped = this.pending.splice(this.pendingOffset > 0 ? 1 : 0, 1)[0];
			if (!dropped) break;
			this.pendingBytes -= dropped.length;
			this.droppedBytes += dropped.length;
		}
		if (this.droppedBytes > 0 && this.pendingBytes <= MAX_PENDING_BYTES) {
			// Announce the loss so a viewer can render a gap rather than silently
			// showing a corrupted stream.
			const notice = Buffer.from(
				`${JSON.stringify({ type: "gap", sequence: this.sequence++, dropped_bytes: this.droppedBytes })}\n`,
			);
			this.droppedBytes = 0;
			this.pending.push(notice);
			this.pendingBytes += notice.length;
		}
	}

	private flushFrames(): void {
		const fd = this.openFrameWriter();
		if (fd < 0) return;
		while (this.pending.length > 0) {
			const frame = this.pending[0]!;
			try {
				const written = fs.writeSync(fd, frame, this.pendingOffset, frame.length - this.pendingOffset);
				this.pendingOffset += written;
				if (this.pendingOffset < frame.length) return; // partial; resume later
				this.pending.shift();
				this.pendingBytes -= frame.length;
				this.pendingOffset = 0;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EAGAIN") return; // pipe full
				// The reader went away. Drop the fd and the backlog: a new reader
				// gets a fresh stream rather than one that starts mid-history.
				try {
					fs.closeSync(fd);
				} catch {
					/* already closed */
				}
				this.frameFD = -1;
				this.pending = [];
				this.pendingBytes = 0;
				this.pendingOffset = 0;
				return;
			}
		}
	}

	private openControlReader(): number {
		if (this.controlFD >= 0) return this.controlFD;
		try {
			// O_RDWR, not O_RDONLY: with no writer attached a read-only FIFO reports
			// EOF immediately, and the reader would close on every idle poll.
			this.controlFD = fs.openSync(this.config.controlFIFO, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
		} catch {
			this.controlFD = -1;
		}
		return this.controlFD;
	}

	private pollControls(): void {
		if (this.stopped) return;
		// Output may be waiting on a reader that has since attached.
		this.flushFrames();
		const fd = this.openControlReader();
		if (fd < 0) return;
		const chunk = Buffer.allocUnsafe(4096);
		try {
			const n = fs.readSync(fd, chunk, 0, chunk.length, null);
			if (n === 0) return;
			this.controlBuffer += chunk.subarray(0, n).toString("utf8");
			if (Buffer.byteLength(this.controlBuffer) > MAX_CONTROL_LINE_BYTES) this.controlBuffer = "";
			let newline = this.controlBuffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.controlBuffer.slice(0, newline);
				this.controlBuffer = this.controlBuffer.slice(newline + 1);
				if (Buffer.byteLength(line) <= MAX_CONTROL_LINE_BYTES) this.applyCommand(line);
				newline = this.controlBuffer.indexOf("\n");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
				try {
					fs.closeSync(fd);
				} catch {
					/* already closed */
				}
				this.controlFD = -1;
			}
		}
	}

	private applyCommand(line: string): void {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			return;
		}
		const command = validateTerminalCommand(raw, readLease(this.config));
		if (!command) return;
		try {
			if (command.kind === "stdin") {
				this.inputHandler?.(Buffer.from(command.data!, "base64"));
			} else {
				this.rows = command.rows!;
				this.cols = command.cols!;
				// Applied from IN HERE. The sandbox has its own devpts namespace, so
				// the pts path means nothing on the host and a desktop-side
				// `stty -F` would return 0 having resized a different terminal.
				this.resizeHandler?.(this.rows, this.cols);
				this.writeManifest("ready");
			}
			this.writeFrame({ type: "control_result", id: command.id, ok: true });
		} catch {
			this.writeFrame({ type: "control_result", id: command.id, ok: false });
		}
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.controlTimer) clearInterval(this.controlTimer);
		this.writeManifest("ended");
		this.flushFrames();
		for (const fd of [this.frameFD, this.controlFD]) {
			if (fd >= 0) {
				try {
					fs.closeSync(fd);
				} catch {
					/* already closed */
				}
			}
		}
		this.frameFD = -1;
		this.controlFD = -1;
	}
}
