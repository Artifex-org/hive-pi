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
import { readdirSync, readFileSync } from "node:fs";

export const HELPER_MARKER = "HIVE_PI_HELPER_CHILD";
export const TREE_TOKEN = "HIVE_PI_TREE_TOKENS";

export function isClaudeHelper(env: Record<string, string | undefined> = process.env): boolean {
	return env[HELPER_MARKER] === "1";
}

/** Merge the caller's final child env BEFORE calling this, not after it. */
export function treeSpawnOptions(env: NodeJS.ProcessEnv = process.env): { detached: boolean; env: NodeJS.ProcessEnv } {
	const inherited = env[TREE_TOKEN]?.split(",").filter(Boolean) ?? [];
	return { detached: isClaudeHelper(env), env: { ...env, [TREE_TOKEN]: [...inherited, randomUUID()].join(",") } };
}

type Identity = { pid: number; start: string; state: string; ppid: number; pgid: number };
type Tree = { child: ChildProcess; grouped: boolean; token?: string; root?: Identity; members: Map<number, Identity> };
const live = new Set<Tree>();
const byChild = new WeakMap<ChildProcess, Tree>();

function identity(pid: number): Identity | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
		return { pid, start: fields[19], state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]) };
	} catch { return undefined; } // exited, unreadable, or non-Linux
}

function alive(item: Identity): boolean {
	const current = identity(item.pid);
	return current?.start === item.start && current.state !== "Z" && current.state !== "X";
}

/** Snapshot relation AND token membership before any ancestor can reparent it. */
function discover(tree: Tree): void {
	if (process.platform !== "linux" || tree.child.pid === undefined) return;
	let names: string[];
	try { names = readdirSync("/proc"); } catch { return; }
	const rows = new Map<number, Identity>();
	const currentRoot = identity(tree.child.pid);
	const ownGroup = tree.grouped && tree.root && (!currentRoot || currentRoot.start === tree.root.start);
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		if (pid === process.pid) continue;
		const item = identity(pid);
		if (!item) continue;
		rows.set(pid, item);
		// A surviving original group also owns env-cleared children after root
		// exit. Reject a reused leader PID and validate member identities below.
		if (ownGroup && item.pgid === tree.root!.pid && Number(item.start) >= Number(tree.root!.start)) tree.members.set(pid, item);
		if (tree.token) {
			try {
				const entry = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((e) => e.startsWith(`${TREE_TOKEN}=`));
				if (entry?.slice(TREE_TOKEN.length + 1).split(",").includes(tree.token)) tree.members.set(pid, item);
			} catch { /* permission denied or process exited; ancestry can still identify it */ }
		}
	}
	// Remembered members seed the walk too: TERM can reparent them before KILL,
	// and a surviving wrapper can have spawned another child during its grace.
	const parents = new Set([...tree.members.values()].filter(alive).map((item) => item.pid));
	if (tree.root && alive(tree.root)) parents.add(tree.root.pid);
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

function send(pid: number, signal: NodeJS.Signals): void {
	try { process.kill(pid, signal); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ESRCH" && code !== "EPERM") throw error;
	}
}

function signalTree(tree: Tree, signal: NodeJS.Signals): void {
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
export function trackTree(child: ChildProcess, grouped: boolean, tokens?: string): void {
	const existing = byChild.get(child);
	if (existing) return;
	const entry: Tree = { child, grouped, token: tokens?.split(",").at(-1), root: child.pid === undefined ? undefined : identity(child.pid), members: new Map() };
	byChild.set(child, entry);
	live.add(entry);
	const forget = () => {
		// Even a successful wrapper must not leave detached workers behind. In
		// particular a closed pipe is not proof of a TERM-resistant child's exit.
		if (child.pid !== undefined) signalTree(entry, "SIGKILL");
		live.delete(entry);
	};
	child.once("close", forget);
	child.once("error", forget);
}

export function killAllTrees(signal: NodeJS.Signals): void {
	for (const entry of live) signalTree(entry, signal);
}
