/**
 * Lifetime ownership for spawned helpers and verification jobs.
 *
 * A process group is NOT a tree: GNU timeout changes PGID and setsid changes
 * session. On Linux, discover descendants before signalling ancestors, and
 * find reparented descendants by an inherited, unique job token. Tokens are
 * additive so a helper's nested jobs still belong to the outer helper.
 * Membership is checked against /proc starttime before every signal, including
 * TERM -> KILL escalation. No host-wide polling/watchers are needed.
 *
 * This is cleanup of cooperative child jobs, not a sandbox: a program that
 * scrubs its environment AND reparents outside the owned group can evade discovery. Unreadable procfs
 * and other OSes retain process-group cleanup only. SIGKILL to the OWNER cannot
 * run cleanup; OS cgroups/job objects are required for that stronger contract.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { hostRequire } from "./host-dependencies.ts";

export const HELPER_MARKER = "HIVE_PI_HELPER_CHILD";
export const TREE_TOKEN = "HIVE_PI_TREE_TOKENS";

export function isClaudeHelper(env: Record<string, string | undefined> = process.env): boolean {
	return env[HELPER_MARKER] === "1";
}

/** Merge the caller's final child env BEFORE calling this, not after it. */
export function treeSpawnOptions(env: NodeJS.ProcessEnv = process.env): { detached: boolean; env: NodeJS.ProcessEnv } {
	installShutdownCleanup();
	const inherited = env[TREE_TOKEN]?.split(",").filter(Boolean) ?? [];
	return { detached: isClaudeHelper(env), env: { ...env, [TREE_TOKEN]: [...inherited, randomUUID()].join(",") } };
}

type Identity = { pid: number; start: string; state: string; ppid: number; pgid: number };
type Tree = { child: ChildProcess; grouped: boolean; token?: string; root?: Identity; members: Map<number, Identity>; requireIdentity?: boolean; cleanupError?: Error };
export type TreeOwnershipOptions = { requireIdentity?: boolean };

function ownershipError(): Error {
	return new Error("Child-tree ownership unavailable; operator cleanup required (Linux with readable procfs required)");
}

/** Fail before spawning when verified ownership is unavailable. No portable fallback. */
export function assertTreeIdentityReadable(): void {
	if (process.platform !== "linux") throw ownershipError();
	try {
		readdirSync("/proc");
		if (!identity(process.pid, true)) throw ownershipError();
		readFileSync(`/proc/${process.pid}/environ`, "utf8");
	} catch { throw ownershipError(); }
}
// Pi evaluates extension graphs with separate module caches. Ownership and
// signal installation must still be process-wide, not one copy per extension.
const OWNERS = Symbol.for("hive-pi.child-tree.owners");
type Owners = { live: Set<Tree>; byChild: WeakMap<ChildProcess, Tree>; shutdownInstalled: boolean };
const host = globalThis as typeof globalThis & { [OWNERS]?: Owners };
const owners = host[OWNERS] ??= { live: new Set<Tree>(), byChild: new WeakMap<ChildProcess, Tree>(), shutdownInstalled: false };
const { live, byChild } = owners;

function installShutdownCleanup(): void {
	if (owners.shutdownInstalled) return;
	// Use the SAME signal-exit 3 observer as pinned proper-lockfile 4.1.2.
	// Counting other signal listeners mistakes cleanup observers for handlers
	// and suppresses default termination (and lockfile release).
	const dependency = createRequire(hostRequire().resolve("proper-lockfile"));
	const onExit: (callback: () => void) => () => void = dependency("signal-exit");
	onExit(() => killAllTrees("SIGKILL"));
	owners.shutdownInstalled = true;
}

function identity(pid: number, strict = false): Identity | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
		if (strict && (!/^\d+$/.test(fields[19] ?? "") || !fields[0] || !Number.isInteger(Number(fields[1])) || !Number.isInteger(Number(fields[2])))) throw ownershipError();
		return { pid, start: fields[19], state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]) };
	} catch (error) {
		if (strict && !["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw ownershipError();
		return undefined;
	}
}

function alive(item: Identity, strict = false): boolean {
	const current = identity(item.pid, strict);
	return current?.start === item.start && current.state !== "Z" && current.state !== "X";
}

/** Snapshot relation AND token membership before any ancestor can reparent it. */
function discover(tree: Tree): void {
	if (process.platform !== "linux" || tree.child.pid === undefined) return;
	let names: string[];
	try { names = readdirSync("/proc"); } catch { if (tree.requireIdentity) throw ownershipError(); return; }
	const rows = new Map<number, Identity>();
	const currentRoot = identity(tree.child.pid, tree.requireIdentity);
	const ownGroup = !tree.requireIdentity && tree.grouped && tree.root && (!currentRoot || currentRoot.start === tree.root.start);
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		if (pid === process.pid) continue;
		const item = identity(pid, tree.requireIdentity);
		if (!item) continue;
		if (tree.requireIdentity && ["Z", "X"].includes(item.state)) continue;
		rows.set(pid, item);
		// A surviving original group also owns env-cleared children after root
		// exit. Reject a reused leader PID and validate member identities below.
		if (ownGroup && item.pgid === tree.root!.pid && Number(item.start) >= Number(tree.root!.start)) tree.members.set(pid, item);
		// A per-spawn inherited token cannot belong to an older process. Avoid
		// faulting unrelated workloads' environment pages on every Git close.
		if (tree.token && (!tree.root || Number(item.start) >= Number(tree.root.start))) {
			try {
				const entry = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((e) => e.startsWith(`${TREE_TOKEN}=`));
				if (entry?.slice(TREE_TOKEN.length + 1).split(",").includes(tree.token)) tree.members.set(pid, item);
			} catch (error) {
				// Other users' environments are normally private. Our own unreadable
				// candidates could be token-owned orphans: do not report a clean tree.
				if (tree.requireIdentity && !["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
					// Exit can revoke environ access between the stat and env reads.
					// Zombies/recycled identities need no environment or cleanup signal.
					if (!alive(item, true)) continue;
					try { if (statSync(`/proc/${pid}`).uid === process.getuid?.()) throw ownershipError(); }
					catch (failure) {
						if (!["ENOENT", "ESRCH"].includes((failure as NodeJS.ErrnoException).code ?? "")) throw ownershipError();
					}
				}
				// Legacy portable policy can still identify members by ancestry.
			}
		}
	}
	// Remembered members seed the walk too: TERM can reparent them before KILL,
	// and a surviving wrapper can have spawned another child during its grace.
	const parents = new Set([...tree.members.values()].filter(item => alive(item, tree.requireIdentity)).map((item) => item.pid));
	if (tree.root && alive(tree.root, tree.requireIdentity)) parents.add(tree.root.pid);
	let changed = true;
	while (changed) {
		changed = false;
		for (const item of rows.values()) {
			if (!parents.has(item.pid) && parents.has(item.ppid)) {
				tree.members.set(item.pid, item); parents.add(item.pid); changed = true;
			}
		}
	}
}

function send(pid: number, signal: NodeJS.Signals, strict = false): void {
	try { process.kill(pid, signal); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ESRCH" && (strict || code !== "EPERM")) throw error;
	}
}

function signalTree(tree: Tree, signal: NodeJS.Signals): void {
	if (tree.requireIdentity) {
		try {
			assertTreeIdentityReadable();
			discover(tree);
			// Never signal a group: even a verified member cannot prove every
			// current occupant belongs to this tree. Recheck each individual.
			for (const item of [...tree.members.values()].reverse()) {
				if (alive(item, true)) send(item.pid, signal, true);
			}
			if (tree.root && !tree.members.has(tree.root.pid) && alive(tree.root, true)) send(tree.root.pid, signal, true);
		} catch {
			tree.cleanupError ??= ownershipError();
		}
		if (tree.cleanupError) throw tree.cleanupError;
		return;
	}
	discover(tree);
	const groupMember = [...tree.members.values()].some(item => item.pgid === tree.child.pid && alive(item));
	// Without procfs retain the portable group-only fallback, including an
	// exited wrapper whose original group still holds pipes. Starttime-checked
	// signalling is available only when procfs itself is readable.
	const ownRoot = process.platform !== "linux" || identity(process.pid) === undefined || (tree.root !== undefined
		? alive(tree.root)
		: tree.child.exitCode === null && tree.child.signalCode === null);
	if (tree.grouped && tree.child.pid !== undefined && (ownRoot || groupMember)) send(-tree.child.pid, signal);
	// The pre-signal snapshot survives reparenting when the group/root dies.
	for (const item of [...tree.members.values()].reverse()) {
		if (item.pid !== tree.child.pid && alive(item)) send(item.pid, signal);
	}
	if (ownRoot || tree.root === undefined) tree.child.kill(signal);
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals, grouped: boolean): void {
	let tree = byChild.get(child);
	if (!tree) {
		tree = { child, grouped, root: child.pid === undefined ? undefined : identity(child.pid), members: new Map() };
		byChild.set(child, tree);
	}
	signalTree(tree, signal);
}

/** Pass the token-bearing child env's TREE_TOKEN value, not the parent's env. */
export function trackTree(child: ChildProcess, grouped: boolean, tokens?: string, options: TreeOwnershipOptions = {}): void {
	installShutdownCleanup();
	const existing = byChild.get(child);
	if (existing) return;
	const entry: Tree = { child, grouped, token: tokens?.split(",").at(-1), members: new Map(), requireIdentity: options.requireIdentity };
	try {
		entry.root = child.pid === undefined ? undefined : identity(child.pid, options.requireIdentity);
		if (entry.requireIdentity && entry.root && entry.token) {
			// A very short-lived leader may have been recycled before capture.
			const env = readFileSync(`/proc/${entry.root.pid}/environ`, "utf8").split("\0").find(value => value.startsWith(`${TREE_TOKEN}=`));
			if (!env?.slice(TREE_TOKEN.length + 1).split(",").includes(entry.token)) entry.root = undefined;
		}
	} catch (error) {
		entry.root = undefined;
		if (!entry.requireIdentity || !["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) entry.cleanupError = ownershipError();
	}
	byChild.set(child, entry);
	live.add(entry);
	const forget = () => {
		// Even a successful wrapper must not leave detached workers behind. In
		// particular a closed pipe is not proof of a TERM-resistant child's exit.
		if (entry.requireIdentity) {
			if (!live.has(entry)) return;
			// Event observers cannot throw; explicit kill/release surfaces the latch.
			try { if (child.pid !== undefined) signalTree(entry, "SIGKILL"); } catch { /* latched */ }
			return; // retain orphan discovery and failure evidence until scope release
		}
		if (child.pid !== undefined) signalTree(entry, "SIGKILL");
		live.delete(entry);
	};
	child.once("close", forget);
	child.once("error", forget);
}

/** Release only after the explicit owner has finished cleanup. */
export function releaseTree(child: ChildProcess): void {
	const tree = byChild.get(child);
	if (tree?.cleanupError) throw tree.cleanupError;
	if (tree) live.delete(tree);
	// Retain strict policy in the WeakMap for delayed SDK transport callbacks.
	// Dropping it would let killTree rebuild this handle with portable fallback.
	if (!tree?.requireIdentity) byChild.delete(child);
}

export function killAllTrees(signal: NodeJS.Signals): void {
	for (const entry of live) {
		if (entry.requireIdentity) {
			try { signalTree(entry, signal); } catch { /* latched for explicit owner */ }
		} else signalTree(entry, signal);
	}
}
