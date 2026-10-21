/** Private, cooperative test-run storage; never a shared-/tmp reaper. */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { TREE_TOKEN } from "../extensions/hive-common/child-tree.ts";

type Identity = { pid: number; start: string };
type Domain = { boot: string; namespace: string };
type Owner = { version: 2; token: string; domain: Domain | null; owner: Identity | null };
export type TempRun = { root: string; path: string; token: string; owner: Owner };
export type CleanupResult = { status: "removed" | "retained" | "error"; reason: string };
const retained = (reason: string): CleanupResult => ({ status: "retained", reason });

function missing(error: unknown): boolean {
	return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
}
function identity(pid: number): Identity | null {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
		if (!/^\d+$/.test(fields[19] ?? "")) throw new Error("Unreadable process identity");
		return { pid, start: fields[19] };
	} catch (error) { if (missing(error)) return null; throw error; }
}
function domain(): Domain | null {
	if (process.platform !== "linux") return null;
	return { boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), namespace: readlinkSync("/proc/self/ns/pid") };
}
function privateDirectory(path: string) {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path) {
		throw new Error(`Test temporary directory must be private, owned, and free of symlink ancestors: ${path}`);
	}
	return stat;
}
function regularJson(path: string): unknown {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.size > 4096) throw new Error("Invalid test-run ownership record");
	return JSON.parse(readFileSync(path, "utf8"));
}
function validIdentity(value: unknown): value is Identity {
	const item = value as Identity | null;
	return !!item && Number.isSafeInteger(item.pid) && item.pid > 0 && typeof item.start === "string" && /^\d+$/.test(item.start);
}
function ownerAt(path: string): Owner {
	const owner = regularJson(join(path, "owner.json")) as Owner;
	if (owner?.version !== 2 || !/^[0-9a-f-]{36}$/.test(owner.token) || (owner.owner !== null && !validIdentity(owner.owner)) ||
		(owner.domain !== null && (typeof owner.domain?.boot !== "string" || typeof owner.domain?.namespace !== "string"))) throw new Error("Invalid test-run ownership record");
	return owner;
}

export function tempRoot(): string {
	const root = process.env.HIVE_PI_TEST_TMP_ROOT ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "hive-pi", "tests");
	if (!isAbsolute(root)) throw new Error("HIVE_PI_TEST_TMP_ROOT must be absolute");
	return resolve(root);
}
function managedAncestor(start: string): string | undefined {
	for (let parent = start; parent !== dirname(parent); parent = dirname(parent)) {
		if (!/^(r-|reap-)/.test(basename(parent))) continue;
		try { ownerAt(parent); return parent; }
		catch (error) { if (!missing(error)) throw error; }
	}
}
export function prepareRoot(root: string): void {
	// Procfs escapes control characters in pathnames; don't accept ambiguous roots.
	if (/[\x00-\x1f\x7f]/.test(root)) throw new Error("Control characters in test temporary root");
	let ancestor = root;
	while (true) {
		try { if (realpathSync(ancestor) !== ancestor) throw new Error("Symlink in test temporary root"); break; }
		catch (error) { if (!missing(error)) throw error; ancestor = dirname(ancestor); }
	}
	// Protect nested bootstrap and recovery, before writing beneath a parent run.
	const parent = managedAncestor(root);
	if (parent) registerReader(parent);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	privateDirectory(root);
	const type = Number(statfsSync(root).type);
	if ([0x01021994, 0x858458f6].includes(type >>> 0)) throw new Error("Test temporary root must be disk-backed, not tmpfs/ramfs");
}
export function createRun(root: string, token: string): TempRun {
	prepareRoot(root);
	const path = mkdtempSync(join(root, "r-"));
	const owner: Owner = { version: 2, token, domain: domain(), owner: process.platform === "linux" ? identity(process.pid) : null };
	writeFileSync(join(path, "owner.json"), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
	for (const name of ["tmp", "readers"]) mkdirSync(join(path, name), { mode: 0o700 });
	return { root, path, token, owner };
}

/** Register BEFORE artifact access/handoff. A native child must be held until admission. */
export function registerReader(path: string, pid = process.pid): void {
	if (process.platform !== "linux") return; // isolation still works; cleanup retains
	const published: string[] = [];
	try { admitReader(path, pid, published); }
	catch (error) {
		const failures: unknown[] = [];
		for (const file of published.reverse()) { try { rmSync(file, { force: true }); } catch (failure) { failures.push(failure); } }
		if (failures.length) throw new AggregateError([error, ...failures], "Reader admission and lease rollback failed");
		throw error;
	}
}
function admitReader(path: string, pid: number, published: string[]): void {
	const before = privateDirectory(path);
	const owner = ownerAt(path);
	const here = domain();
	if (owner.domain && (!here || owner.domain.boot !== here.boot || owner.domain.namespace !== here.namespace)) throw new Error("Reader identity domain differs from test run");
	// A parent owns recursive deletion, so admission must fence every enclosing run.
	// Discover these from the filesystem: intentional readers may clear their env.
	const parent = managedAncestor(dirname(path));
	if (parent) admitReader(parent, pid, published);
	const reader = identity(pid);
	if (!reader) throw new Error("Reader exited before test-run admission");
	const readers = join(path, "readers");
	privateDirectory(readers);
	const nonce = randomUUID();
	const pending = join(readers, `pending-${nonce}`);
	const lease = join(readers, `reader-${nonce}.json`);
	writeFileSync(pending, JSON.stringify(reader), { mode: 0o600, flag: "wx" });
	published.push(pending);
	renameSync(pending, lease);
	published[published.length - 1] = lease;
	// Publish BEFORE checking the closing barrier. Cleanup creates the barrier
	// BEFORE inspecting leases. Thus an admitted reader is in its snapshot;
	// a late publisher must fail before accessing any artifact.
	try { lstatSync(join(path, "closing")); throw new Error("Test run is closing; reader not admitted"); }
	catch (error) { if (!missing(error)) throw error; }
	const after = privateDirectory(path);
	if (after.dev !== before.dev || after.ino !== before.ino || ownerAt(path).token !== owner.token) throw new Error("Test run changed during reader admission");
}

/** Missing child publication means interrupted bootstrap, never permission to reap. */
export function markRunner(path: string): void {
	privateDirectory(path);
	writeFileSync(join(path, "runner.json"), JSON.stringify(process.platform === "linux" ? identity(process.pid) : null), { mode: 0o600, flag: "wx" });
}
function zombie(item: Identity): boolean {
	const raw = readFileSync(`/proc/${item.pid}/stat`, "utf8");
	const state = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/)[0];
	return ["Z", "X"].includes(state) && /^Threads:\s+1\s*$/m.test(readFileSync(`/proc/${item.pid}/status`, "utf8")) && identity(item.pid)?.start === item.start;
}
function life(item: Identity): "alive" | "dead" | "unknown" {
	try { return identity(item.pid)?.start === item.start && !zombie(item) ? "alive" : "dead"; }
	catch (error) { return missing(error) ? "dead" : "unknown"; }
}

function referencesRun(pid: number, path: string): boolean {
	const inside = (target: string) => {
		const name = target.replace(/ \(deleted\)$/, "");
		return name === path || name.startsWith(path + "/");
	};
	for (const link of ["cwd", "exe", "root"]) if (inside(readlinkSync(`/proc/${pid}/${link}`))) return true;
	let sockets: Map<string, string> | undefined;
	const descriptors = opendirSync(`/proc/${pid}/fd`);
	try { for (let entry = descriptors.readSync(); entry; entry = descriptors.readSync()) {
		const target = readlinkSync(`/proc/${pid}/fd/${entry.name}`);
		if (inside(target)) return true;
		const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
		if (!inode) continue;
		sockets ??= new Map(readFileSync(`/proc/${pid}/net/unix`, "utf8").split("\n").slice(1).filter(Boolean).map(line => {
			const match = /^(?:\S+\s+){6}(\d+)(?: (.*))?$/.exec(line.trimStart());
			if (!match) throw new Error("Unreadable Unix socket table");
			return [match[1], match[2] ?? ""];
		}));
		if (inside(sockets.get(inode) ?? "")) return true;
	} } finally { descriptors.closeSync(); }
	return readFileSync(`/proc/${pid}/maps`, "utf8").split("\n").some(line => inside(line.replace(/^(?:\S+\s+){5}/, "")));
}

/** Additive protection, NOT an absence proof. Opaque unrelated actors are not owned. */
function observableReader(owner: Owner, path: string): boolean {
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		try {
			const item = identity(pid);
			if (!item || statSync(`/proc/${pid}`).uid !== process.getuid?.() || zombie(item)) continue;
			if (referencesRun(pid, path)) return true;
			if (owner.owner && BigInt(item.start) < BigInt(owner.owner.start)) continue;
			const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
			const tokens = env.find(entry => entry.startsWith(`${TREE_TOKEN}=`))?.slice(TREE_TOKEN.length + 1).split(",");
			if (tokens?.includes(owner.token)) return true;
		} catch { /* unowned/unobservable: durable leases remain authoritative */ }
	}
	return false;
}

/** Normal completion may ignore only its verified live owner; recovery ignores nobody. */
export function cleanRun(root: string, path: string, ownToken?: string): CleanupResult {
	let closing: string | undefined;
	try {
		const rootStat = privateDirectory(root);
		if (dirname(path) !== root || !/^(r-|reap-)[a-zA-Z0-9-]+$/.test(path.slice(root.length + 1))) return retained("outside owned namespace");
		const before = privateDirectory(path);
		const owner = ownerAt(path);
		const here = domain();
		if (!owner.owner || !owner.domain || !here || here.boot !== owner.domain.boot || here.namespace !== owner.domain.namespace) return retained("unsupported or different process domain");
		if (ownToken !== undefined) {
			if (owner.token !== ownToken || owner.owner.pid !== process.pid || life(owner.owner) !== "alive") return retained("owner identity mismatch");
		} else if (life(owner.owner) !== "dead") return retained("owner alive or unreadable");
		let runner: unknown;
		try { runner = regularJson(join(path, "runner.json")); } catch { return retained("unpublished runner"); }
		if (!validIdentity(runner) || life(runner) !== "dead") return retained("runner alive or unreadable");
		// Native descendants that stay in the runner's group are owned even if
		// they cannot execute the Node preload. Unknown/nonempty groups retain.
		// Even a seemingly zombie-only group can conceal an unreadable live member.
		try { process.kill(-runner.pid, 0); return retained("runner process group still exists"); }
		catch (error) { if (!missing(error)) return retained("runner group unreadable"); }
		const barrier = join(path, "closing");
		try { writeFileSync(barrier, JSON.stringify(identity(process.pid)), { mode: 0o600, flag: "wx" }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return retained("cleanup claimed or interrupted"); throw error; }
		closing = barrier;
		const readers = join(path, "readers");
		privateDirectory(readers);
		for (const name of readdirSync(readers)) {
			if (name.startsWith("pending-")) continue; // never admitted; publication checks closing
			const reader = regularJson(join(readers, name));
			if (!validIdentity(reader)) return retained("incomplete reader publication");
			if (life(reader) !== "dead") return retained("registered reader alive or unreadable");
		}
		if (observableReader(owner, path)) return retained("observable reader");
		const currentRoot = privateDirectory(root);
		if (currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) return retained("root changed");
		const claimed = join(root, `reap-${randomUUID()}`);
		renameSync(path, claimed);
		closing = undefined; // the barrier travels with the claimed run
		const after = privateDirectory(claimed);
		if (after.dev !== before.dev || after.ino !== before.ino || ownerAt(claimed).token !== owner.token) return retained("run changed during claim");
		rmSync(claimed, { recursive: true });
		return { status: "removed", reason: "owned readers finished" };
	} catch (error) {
		return missing(error) ? retained("run changed or unpublished") : { status: "error", reason: String(error) };
	} finally {
		if (closing) rmSync(closing); // only this caller's successfully acquired barrier
	}
}
export function recoverRuns(root: string): void {
	prepareRoot(root);
	for (const name of readdirSync(root)) {
		if (!/^(r-|reap-)[a-zA-Z0-9-]+$/.test(name)) continue;
		const result = cleanRun(root, join(root, name));
		if (result.status !== "removed") console.error(`Test temporary run retained (${result.reason}): ${join(root, name)}`);
	}
}
