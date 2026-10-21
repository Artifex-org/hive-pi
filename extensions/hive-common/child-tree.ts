import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

export const HELPER_MARKER = "HIVE_PI_HELPER_CHILD";
export function isClaudeHelper(env: Record<string, string | undefined> = process.env): boolean {
	return env[HELPER_MARKER] === "1";
}
export const TREE_TOKEN = "HIVE_PI_TREE_TOKENS";
export type TreeSpawnOptions = { detached: boolean; env: NodeJS.ProcessEnv };
export function treeSpawnOptions(env: Record<string, string | undefined> = process.env): TreeSpawnOptions {
	const token = randomUUID();
	const inherited = env[TREE_TOKEN]?.split(",").filter(Boolean) ?? [];
	return { detached: isClaudeHelper(env), env: { ...env, [TREE_TOKEN]: [...new Set([...inherited, token])].join(",") } };
}

type Identity = { pid: number; start: string };
type Tree = { child: ChildProcess; grouped: boolean; token?: string; root?: Identity; members: Map<number, string> };
const live = new Set<Tree>();
const byChild = new WeakMap<ChildProcess, Tree>();

/** Read Linux procfs once and snapshot the complete descendant relation before signaling. */
function snapshot(root: number): Identity[] {
	if (process.platform !== "linux") return [];
	const rows = new Map<number, { ppid: number; start: string }>();
	try {
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			try {
				const stat = readFileSync(`/proc/${name}/stat`, "utf8");
				const close = stat.lastIndexOf(")");
				const fields = stat.slice(close + 2).split(" "); // begins state (field 3)
				rows.set(Number(name), { ppid: Number(fields[1]), start: fields[19] }); // starttime field 22
			} catch { /* process exited during the procfs walk */ }
		}
	} catch { return []; }
	const found = new Map<number, string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, row] of rows) {
			if (!found.has(pid) && (row.ppid === root || found.has(row.ppid)) && pid !== process.pid) {
				found.set(pid, row.start);
				changed = true;
			}
		}
	}
	return [...found].map(([pid, start]) => ({ pid, start }));
}

function sameProcess(identity: Identity): boolean {
	try {
		const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19] === identity.start && fields[0] !== "Z" && fields[0] !== "X";
	} catch { return false; }
}

function discoverTokenMembers(tree: Tree): void {
	if (process.platform !== "linux" || !tree.token) return;
	try {
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
			try {
				const environ = readFileSync(`/proc/${name}/environ`, "utf8");
				const item = environ.split("\\0").find((entry) => entry.startsWith(`${TREE_TOKEN}=`));
				if (item?.slice(TREE_TOKEN.length + 1).split(",").includes(tree.token)) {
					const stat = readFileSync(`/proc/${name}/stat`, "utf8");
					tree.members.set(Number(name), stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
				}
			} catch { /* process exited or procfs access is unavailable */ }
		}
	} catch { /* procfs unavailable: process-group fallback remains */ }
}

function signalTree(tree: Tree, signal: NodeJS.Signals): void {
	if (process.platform === "linux" && tree.child.pid !== undefined) {
		if (tree.root && sameProcess(tree.root)) for (const item of snapshot(tree.child.pid)) tree.members.set(item.pid, item.start);
		discoverTokenMembers(tree);
	}
	if (process.platform === "linux" && tree.members.size) {
		for (const [pid, start] of tree.members) if (sameProcess({ pid, start })) {
			try { process.kill(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
		}
	}
	if (tree.grouped && tree.child.pid !== undefined && (!tree.root || sameProcess(tree.root))) {
		try { process.kill(-tree.child.pid, signal); return; }
		catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ESRCH" && code !== "EPERM") throw error; }
	}
	try { tree.child.kill(signal); } catch { /* process already exited */ }
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals, grouped: boolean): void {
	let tree = byChild.get(child);
	if (!tree) { tree = { child, grouped, root: child.pid === undefined ? undefined : identity(child.pid), members: new Map() }; byChild.set(child, tree); }
	signalTree(tree, signal);
}

function identity(pid: number): Identity | undefined {
	try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return { pid, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] }; } catch { return undefined; }
}

export function trackTree(child: ChildProcess, grouped: boolean, token?: string): void {
	const entry: Tree = { child, grouped, token, root: child.pid === undefined ? undefined : identity(child.pid), members: new Map() };
	byChild.set(child, entry);
	live.add(entry);
	const forget = () => live.delete(entry);
	child.once("close", forget);
	child.once("error", forget);
}

export function killAllTrees(signal: NodeJS.Signals): void {
	for (const entry of live) signalTree(entry, signal);
}
