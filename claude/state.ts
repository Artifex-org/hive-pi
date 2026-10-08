/**
 * The adapter's private state under `$HIVE_CLAUDE_CONFIG_DIR/hive-pi/`.
 *
 * Every hook is a fresh process, so anything pi keeps in a closure for the
 * life of a session (the goal, the agenda ledger, drift's cadence counter,
 * the YSK cursor) lives here instead. Writes are atomic (temp file + rename)
 * so a reader never sees half a document, and the directory is private
 * (0700, files 0600): it holds a session's goal text and finding ids.
 *
 * `control.json` is the DRIVER's: the adapter only reads it.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isOpMode, type OpMode } from "../extensions/opmode/modes.ts";

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** The parsed document, or undefined when the file does not exist. A malformed file throws: it is not "absent". */
export function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf8");
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
	}
}

export function writeJsonAtomic(path: string, data: unknown): void {
	ensureDir(dirname(path));
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists and belongs to someone else — alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * An exclusive lock file holding the owner's pid. Returns a release function,
 * or null when a LIVE process holds it. A lock left by a dead process is
 * taken over — a crashed hook must not wedge the feature for the session.
 */
export function tryLock(path: string): (() => void) | null {
	ensureDir(dirname(path));
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeFileSync(fd, String(process.pid));
			closeSync(fd);
			return () => {
				if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
			if (Number.isSafeInteger(holder) && holder > 0 && pidAlive(holder)) return null;
			unlinkSync(path);
		}
	}
	return null;
}

export interface YskControl {
	enabled: boolean;
	/** The operator's recording choice, when the driver has one. */
	recording?: boolean;
	/** The server recording-policy revision that choice was made against. */
	recordingRevision?: number;
}

export interface Control {
	opMode: OpMode;
	ysk: YskControl;
}

export const DEFAULT_CONTROL: Control = { opMode: "build", ysk: { enabled: true } };

export function controlPath(stateDir: string): string {
	return join(stateDir, "control.json");
}

/**
 * The driver's control document; absent means defaults. Present but invalid
 * THROWS — an unreadable op mode must never be read as "build", which would
 * silently lift a discuss-mode restriction the operator set.
 */
export function readControl(stateDir: string): Control {
	const raw = readJson(controlPath(stateDir));
	if (raw === undefined) return DEFAULT_CONTROL;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("control.json is not an object");
	const doc = raw as { opMode?: unknown; ysk?: unknown };
	const opMode = doc.opMode === undefined ? DEFAULT_CONTROL.opMode : doc.opMode;
	if (!isOpMode(opMode)) throw new Error(`control.json names an unknown opMode ${JSON.stringify(doc.opMode)}`);
	const ysk: YskControl = { enabled: true };
	if (doc.ysk !== undefined) {
		if (!doc.ysk || typeof doc.ysk !== "object") throw new Error("control.json ysk is not an object");
		const y = doc.ysk as { enabled?: unknown; recording?: unknown; recordingRevision?: unknown };
		if (y.enabled !== undefined && typeof y.enabled !== "boolean") throw new Error("control.json ysk.enabled is not a boolean");
		if (y.recording !== undefined && typeof y.recording !== "boolean") throw new Error("control.json ysk.recording is not a boolean");
		if (y.recordingRevision !== undefined && !(Number.isSafeInteger(y.recordingRevision) && (y.recordingRevision as number) >= 0)) {
			throw new Error("control.json ysk.recordingRevision is not a non-negative integer");
		}
		ysk.enabled = y.enabled !== false;
		if (typeof y.recording === "boolean") ysk.recording = y.recording;
		if (typeof y.recordingRevision === "number") ysk.recordingRevision = y.recordingRevision;
	}
	return { opMode, ysk };
}
