import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export const HELPER_MARKER = "HIVE_PI_HELPER_CHILD";
export function isClaudeHelper(env: Record<string, string | undefined> = process.env): boolean {
	return env[HELPER_MARKER] === "1";
}
export function treeSpawnOptions(env: Record<string, string | undefined> = process.env): { detached: boolean } {
	return { detached: isClaudeHelper(env) };
}

type Identity = { pid: number; start: string };
type Tree = { child: ChildProcess; grouped: boolean; members: Map<number, string> };
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
	let frontier = [root];
	while (frontier.length) {
		const parents = new Set(frontier);
		frontier = [];
		for (const [pid, row] of rows) {
			if (!found.has(pid) && parents.has(row.ppid) && pid !== process.pid) {
				found.set(pid, row.start);
				frontier.push(pid);
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

function signalTree(tree: Tree, signal: NodeJS.Signals): void {
	if (process.platform === "linux" && tree.child.pid !== undefined) {
		for (const item of snapshot(tree.child.pid)) tree.members.set(item.pid, item.start);
	}
	if (process.platform === "linux" && tree.members.size) {
		for (const [pid, start] of tree.members) if (sameProcess({ pid, start })) {
			try { process.kill(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
		}
	}
	if (tree.grouped && tree.child.pid !== undefined) {
		try { process.kill(-tree.child.pid, signal); return; }
		catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ESRCH" && code !== "EPERM") throw error; }
	}
	try { tree.child.kill(signal); } catch { /* process already exited */ }
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals, grouped: boolean): void {
	let tree = byChild.get(child);
	if (!tree) { tree = { child, grouped, members: new Map() }; byChild.set(child, tree); }
	signalTree(tree, signal);
}

export function trackTree(child: ChildProcess, grouped: boolean): void {
	const entry: Tree = { child, grouped, members: new Map() };
	byChild.set(child, entry);
	live.add(entry);
	const forget = () => live.delete(entry);
	child.once("close", forget);
	child.once("error", forget);
}

export function killAllTrees(signal: NodeJS.Signals): void {
	for (const entry of live) signalTree(entry, signal);
}
