/**
 * Cross-process admission for automatic gates. One canonical-worktree lease,
 * two advisory execution slots per shared namespace. Linux actual commands add
 * execution-held native locks: heartbeat expiry is not execution termination.
 * Receipts record attempts, not green evidence; pending notices survive death.
 * Heartbeats recover metadata owners without trusting namespace-local PIDs.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { ExecutionAdmission } from "./execution-admission.ts";
import { hostRequire } from "../hive-common/host-dependencies.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_MS = 30_000;
const AUTOMATIC_SLOTS = 2;

/** A pending notice always has an identity; both disappear on delivery. */
export type GateReceipt = {
	input: string;
	outcome: "running" | "pass" | "fail" | "timeout" | "incomplete";
} & ({ notice?: undefined; noticeId?: undefined } | { notice: string; noticeId: string });
/** Delivery/liveness only: never identifies source or deduplicates an attempt. */
export interface GateNotice {
	id: string;
	configuration: string;
	content: string;
}
export interface GateLease {
	/** Native command-lifetime protection where supported; metadata locks remain advisory. */
	readonly execution?: ExecutionAdmission;
	signal: AbortSignal;
	readonly waitedForSlot: boolean;
	/** Receipt lookup needs only the root lock; reserve a slot only to execute. */
	admit(): Promise<boolean>;
	read(): Promise<GateReceipt | undefined>;
	write(receipt: GateReceipt): Promise<void>;
	readNotice(): Promise<GateNotice | undefined>;
	writeNotice(notice: GateNotice | undefined): Promise<void>;
	release(): Promise<void>;
}
export interface GateLeaseOptions {
	/** Isolated directory/slot count for real-lock tests, not runtime knobs. */
	directory?: string;
	slots?: number;
	/** Read/deduplicate under the root lock before requesting execution capacity. */
	deferSlot?: boolean;
}

export async function acquireGateLease(
	root: string,
	deadline: () => number,
	signal?: AbortSignal,
	options: GateLeaseOptions = {},
): Promise<GateLease | null> {
	if (signal?.aborted) return null;
	// Claude's plain-Node source checkout has no checkout dependencies. Reuse
	// proper-lockfile 4.1.2 from the launch-pinned pi's DIRECT dependencies.
	// pi/npm consumers without a Claude pin use this installed package's deps.
	// A supplied but invalid pin must fail, never silently use another runtime.
	const require = hostRequire();
	const lockfile: typeof import("proper-lockfile") = require("proper-lockfile");
	// POSIX helpers must share the SAME location even when their TMPDIR differs.
	// This coordinates a shared filesystem/mount namespace, not isolated hosts.
	const directory = options.directory ?? join(process.platform === "win32" ? tmpdir() : "/tmp", `hive-pi-auto-gates-${process.getuid?.() ?? "user"}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	const wrongOwner = typeof process.geteuid === "function" && info.uid !== process.geteuid();
	if (!info.isDirectory() || (process.platform !== "win32" && (wrongOwner || (info.mode & 0o077) !== 0))) {
		throw new Error(`Automatic gate state must be a private owned directory, not a symlink: ${directory}`);
	}
	const key = createHash("sha256").update(await realpath(root)).digest("hex");
	const path = join(directory, key);
	const controller = new AbortController();
	const acquire = async (name: string): Promise<(() => Promise<void>) | null> => {
		try {
			return await lockfile.lock(name, {
				realpath: false, stale: STALE_MS, update: STALE_MS / 3, retries: 0,
				onCompromised: (error) => controller.abort(error),
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOCKED") return null;
			throw error;
		}
	};
	const unlockRoot = await acquire(path);
	if (!unlockRoot) return null; // same worktree never queues a duplicate attempt
	let unlockSlot: (() => Promise<void>) | null = null;
	let waitedForSlot = false;
	let released = false;
	const admit = async (): Promise<boolean> => {
		if (released) throw new Error("Automatic gate lease already released");
		while (!unlockSlot && !signal?.aborted && !controller.signal.aborted && deadline() > Date.now()) {
			for (let slot = 0; slot < (options.slots ?? AUTOMATIC_SLOTS); slot++) {
				unlockSlot = await acquire(join(directory, `slot-${slot}`));
				if (unlockSlot) break;
			}
			if (unlockSlot) break;
			waitedForSlot = true;
			await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline() - Date.now()))));
		}
		return unlockSlot !== null && !signal?.aborted && !controller.signal.aborted;
	};
	const release = async () => {
		if (released) return;
		released = true;
		try { await unlockSlot?.(); } finally { await unlockRoot(); }
	};
	try {
		if (!options.deferSlot && !await admit()) { await release(); return null; }
	} catch (error) { await release(); throw error; }
	const receiptPath = `${path}.json`;
	const noticePath = `${path}.notice.json`;
	const save = async (file: string, value: unknown) => {
		if (controller.signal.aborted) throw controller.signal.reason;
		const temp = `${file}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
		await rename(temp, file);
	};
	return {
		execution: process.platform === "linux" ? { directory, rootLock: `${path}.kernel`, slots: options.slots ?? AUTOMATIC_SLOTS } : undefined,
		signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
		get waitedForSlot() { return waitedForSlot; },
		admit,
		read: async () => {
			let text: string;
			try { text = await readFile(receiptPath, "utf8"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
			const receipt: unknown = JSON.parse(text);
			if (!receipt || typeof receipt !== "object" || !("input" in receipt) || typeof receipt.input !== "string" ||
				!("outcome" in receipt) || !["running", "pass", "fail", "timeout", "incomplete"].includes(String(receipt.outcome)) ||
				("noticeId" in receipt && !("notice" in receipt)) ||
				("notice" in receipt && (typeof receipt.notice !== "string" || !("noticeId" in receipt) || typeof receipt.noticeId !== "string"))) throw new Error(`Invalid automatic gate receipt: ${receiptPath}`);
			return receipt as GateReceipt;
		},
		write: (receipt) => save(receiptPath, receipt),
		readNotice: async () => {
			let text: string;
			try { text = await readFile(noticePath, "utf8"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
			const notice: unknown = JSON.parse(text);
			if (!notice || typeof notice !== "object" || !("id" in notice) || typeof notice.id !== "string" || !("configuration" in notice) || typeof notice.configuration !== "string" ||
				!("content" in notice) || typeof notice.content !== "string") {
				throw new Error(`Invalid automatic gate delivery notice: ${noticePath}`);
			}
			return notice as GateNotice;
		},
		writeNotice: async (notice) => {
			if (controller.signal.aborted) throw controller.signal.reason;
			if (notice) await save(noticePath, notice);
			else await rm(noticePath, { force: true });
		},
		release,
	};
}
