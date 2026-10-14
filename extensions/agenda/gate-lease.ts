/**
 * Cross-process admission for automatic gates. One canonical-worktree lease,
 * two execution slots per user/host. Receipts record attempts, not cached green
 * evidence; pending notices survive owner death until the host delivers them.
 * Heartbeats recover crashed owners without trusting namespace-local PIDs.
 */
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_MS = 30_000;
const AUTOMATIC_SLOTS = 2;

export interface GateReceipt {
	input: string;
	outcome: "running" | "pass" | "fail" | "timeout" | "incomplete";
	/** Persisted separately from the attempt verdict; cleared only on delivery. */
	notice?: string;
}
export interface GateLease {
	signal: AbortSignal;
	readonly waitedForSlot: boolean;
	/** Receipt lookup needs only the root lock; reserve a slot only to execute. */
	admit(): Promise<boolean>;
	read(): Promise<GateReceipt | undefined>;
	write(receipt: GateReceipt): Promise<void>;
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
	const require = createRequire(process.env.HIVE_PI_BIN ? realpathSync(process.env.HIVE_PI_BIN) : import.meta.url);
	const lockfile: typeof import("proper-lockfile") = require("proper-lockfile");
	const directory = options.directory ?? join(tmpdir(), `hive-pi-auto-gates-${process.getuid?.() ?? "user"}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
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
	return {
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
				("notice" in receipt && typeof receipt.notice !== "string")) throw new Error(`Invalid automatic gate receipt: ${receiptPath}`);
			return receipt as GateReceipt;
		},
		write: async (receipt) => {
			if (controller.signal.aborted) throw controller.signal.reason;
			const temp = `${receiptPath}.${randomUUID()}.tmp`;
			await writeFile(temp, JSON.stringify(receipt), { mode: 0o600 });
			await rename(temp, receiptPath);
		},
		release,
	};
}
