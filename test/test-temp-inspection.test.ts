import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanRun, createRun, registerReader } from "../scripts/test-temp.ts";

vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync), readlinkSync: vi.fn(actual.readlinkSync), readdirSync: vi.fn(actual.readdirSync), opendirSync: vi.fn(actual.opendirSync), renameSync: vi.fn(actual.renameSync), statSync: vi.fn(actual.statSync) };
});
const actual = await vi.importActual<typeof fs>("node:fs");
const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync); vi.mocked(fs.readlinkSync).mockImplementation(actual.readlinkSync);
	vi.mocked(fs.readdirSync).mockImplementation(actual.readdirSync); vi.mocked(fs.statSync).mockImplementation(actual.statSync);
	vi.mocked(fs.opendirSync).mockImplementation(actual.opendirSync); vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
	for (const dir of dirs.splice(0)) actual.rmSync(dir, { recursive: true, force: true });
});
function procStat(pid: number, start: string, state = "S", group = "99") {
	return `${pid} (fixture) ${[state, "1", group, ...Array(16).fill("0"), start].join(" ")}`;
}
function fixture(options: { vanished?: boolean; inaccessible?: boolean; socket?: boolean; zombie?: boolean; foreign?: boolean; self?: boolean; owned?: boolean; opaqueOwner?: boolean; zombieGroup?: boolean; liveGroup?: boolean } = {}) {
	const base = actual.mkdtempSync(join(tmpdir(), "i-")); dirs.push(base);
	const run = createRun(join(base, "runs  with spaces"), "11111111-1111-4111-8111-111111111111");
	actual.writeFileSync(join(run.path, "owner.json"), JSON.stringify({ ...run.owner, owner: { pid: 900001, start: "10" } }));
	actual.writeFileSync(join(run.path, "runner.json"), JSON.stringify({ pid: 900002, start: "11" }));
	if (options.owned) actual.writeFileSync(join(run.path, "readers", "900003-12.json"), JSON.stringify({ pid: 900003, start: "12" }));
	const gone = () => Object.assign(new Error("gone"), { code: "ENOENT" });
	const kill = process.kill;
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => { if (pid === -900002) { if (options.zombieGroup || options.liveGroup) return true; throw Object.assign(new Error("no group"), { code: "ESRCH" }); } return kill(pid, signal); });
	vi.mocked(fs.readdirSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
		if (String(path) === "/proc") return ["900003", ...(options.zombieGroup ? ["900002"] : []), ...(options.self ? [String(process.pid)] : [])];
		return Reflect.apply(actual.readdirSync, null, [path, ...args]);
	}) as typeof fs.readdirSync);
	vi.mocked(fs.opendirSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
		if (String(path) === "/proc/900003/fd") {
			const entries = options.socket ? [{ name: "5" }] : [];
			return { readSync: () => entries.shift() ?? null, closeSync() {} };
		}
		return Reflect.apply(actual.opendirSync, null, [path, ...args]);
	}) as typeof fs.opendirSync);
	vi.mocked(fs.statSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
		if (String(path) === "/proc/900003") return { uid: options.foreign ? process.getuid!() + 1 : process.getuid!() };
		return Reflect.apply(actual.statSync, null, [path, ...args]);
	}) as typeof fs.statSync);
	vi.mocked(fs.readlinkSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
		if (String(path).startsWith("/proc/900003/")) {
			if (options.inaccessible) throw Object.assign(new Error("private"), { code: "EACCES" });
			return String(path).endsWith("/fd/5") ? "socket:[42]" : "/unrelated";
		}
		return Reflect.apply(actual.readlinkSync, null, [path, ...args]);
	}) as typeof fs.readlinkSync);
	vi.mocked(fs.readFileSync).mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
		const name = String(path);
		if (/^\/proc\/90000[12]\//.test(name)) {
			if (!options.zombie && !options.zombieGroup) throw gone();
			return name.endsWith("/stat") ? procStat(Number(name.split("/")[2]), name.includes("900001") ? "10" : "11", "Z", "900002") : "Threads:\t1\n";
		}
		if (name.startsWith("/proc/900003/")) {
			if (options.opaqueOwner) throw Object.assign(new Error("private"), { code: "EACCES" });
			if (options.vanished) throw gone();
			if (name.endsWith("/stat")) return procStat(900003, "12", "S", options.liveGroup ? "900002" : "99");
			if (name.endsWith("/status")) return "Threads:\t1\n";
			if (name.endsWith("/net/unix")) return `Num RefCount Protocol Flags Type St Inode Path\n0: 2 0 10000 1 01 42 ${run.path}/live.sock\n`;
			return "";
		}
		return Reflect.apply(actual.readFileSync, null, [path, ...args]);
	}) as typeof fs.readFileSync);
	return run;
}

it.each([{ vanished: true }, { inaccessible: true }, { foreign: true }])("unrelated process visibility/churn does not block cleanup: %j", options => {
	const run = fixture(options);
	expect(cleanRun(run.root, run.path).status).toBe(process.platform === "linux" ? "removed" : "retained");
});
it.each([{ owned: true }, { owned: true, opaqueOwner: true }])("known live or opaque reader leases prevent cleanup: %j", options => {
	const run = fixture(options);
	expect(cleanRun(run.root, run.path).status).toBe("retained");
	expect(actual.existsSync(run.path)).toBe(true);
	expect(actual.existsSync(join(run.path, "closing"))).toBe(false);
});
it("additively protects an observable unregistered socket with repeated pathname spaces", () => {
	const run = fixture({ socket: true });
	expect(cleanRun(run.root, run.path).status).toBe("retained");
});
it("inspects real self-held descriptors without a transient enumeration-FD failure", () => {
	const run = fixture({ self: true });
	const file = join(run.path, "held"); actual.writeFileSync(file, "reader");
	const fd = actual.openSync(file, "r");
	try { expect(cleanRun(run.root, run.path).status).toBe("retained"); } finally { actual.closeSync(fd); }
	expect(cleanRun(run.root, run.path).status).toBe(process.platform === "linux" ? "removed" : "retained");
});
it("reclaims verified zombie owners when the runner group is gone", () => {
	const run = fixture({ zombie: true });
	expect(cleanRun(run.root, run.path).status).toBe(process.platform === "linux" ? "removed" : "retained");
});
it.each([{ zombieGroup: true }, { zombieGroup: true, opaqueOwner: true }])("retains an existing group even if only zombies are observable: %j", options => {
	const run = fixture(options);
	expect(cleanRun(run.root, run.path).status).toBe("retained");
});
it("retains a live member of the owned group", () => {
	const run = fixture({ liveGroup: true });
	expect(cleanRun(run.root, run.path).status).toBe("retained");
});
it("fences a symlink substitution between inspection and the cleanup claim", () => {
	const run = fixture(); const outside = join(run.root, "outside");
	actual.mkdirSync(outside, { mode: 0o700 }); actual.writeFileSync(join(outside, "keep"), "safe");
	vi.mocked(fs.renameSync).mockImplementation((from, to) => { actual.renameSync(from, String(from) + "-saved"); actual.symlinkSync(outside, from); actual.renameSync(from, to); });
	expect(cleanRun(run.root, run.path).status).not.toBe("removed");
	expect(actual.readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
});
it("an interrupted cleaner quarantines its run instead of reopening admission", () => {
	const run = fixture(); actual.writeFileSync(join(run.path, "closing"), "incomplete");
	expect(cleanRun(run.root, run.path).status).toBe("retained");
	expect(actual.existsSync(run.path)).toBe(true);
});
it("publication before closing protects the admitted reader", () => {
	const run = fixture(); registerReader(run.path);
	expect(cleanRun(run.root, run.path).status).toBe("retained");
	expect(actual.existsSync(join(run.path, "closing"))).toBe(false);
});
it("closing between publication and admission rejects the reader before artifact use", () => {
	const run = fixture(); let accessed = false;
	vi.mocked(fs.renameSync).mockImplementation((from, to) => { actual.renameSync(from, to); actual.writeFileSync(join(run.path, "closing"), "claimed"); });
	if (process.platform === "linux") {
		expect(() => { registerReader(run.path); accessed = true; }).toThrow(/closing/);
		expect(accessed).toBe(false);
	} else expect(cleanRun(run.root, run.path).status).toBe("retained");
});
it("a publisher racing the cleaner's lease snapshot cannot become an admitted reader", () => {
	const run = fixture(); let rejected = false;
	const read = fs.readdirSync;
	vi.mocked(fs.readdirSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
		if (String(path) === join(run.path, "readers")) {
			try { registerReader(run.path); } catch { rejected = true; }
			return []; // snapshot taken before the late publication
		}
		if (String(path) === "/proc") return ["900003"];
		return Reflect.apply(actual.readdirSync, null, [path, ...args]);
	}) as typeof read);
	const result = cleanRun(run.root, run.path);
	if (process.platform === "linux") { expect(rejected).toBe(true); expect(result.status).toBe("removed"); }
	else expect(result.status).toBe("retained");
});
