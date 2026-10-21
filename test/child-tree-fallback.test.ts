import { shellQuote } from "../extensions/toolcwd/cwd.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs, readFileSync: vi.fn((path, ...args) => {
		if (String(path).startsWith("/proc/")) throw Object.assign(new Error("procfs inaccessible"), { code: "EACCES" });
		return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
	}) };
});
import { killTree, trackTree, treeSpawnOptions, TREE_TOKEN } from "../extensions/hive-common/child-tree.ts";

const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(process.platform === "linux")("group fallback without procfs", () => {
	it("kills a surviving original group after its wrapper exited", async () => {
		const dir = fs.mkdtempSync(join(tmpdir(), "tree-fallback-")), file = join(dir, "pid");
		const tree = { ...treeSpawnOptions(), detached: true };
		const child = spawn("bash", ["-c", `sleep 10 & echo $! > ${shellQuote(file)}; exit 0`], { ...tree, stdio: ["ignore", "pipe", "pipe"] });
		trackTree(child, true, tree.env[TREE_TOKEN]); child.stdout.resume(); child.stderr.resume();
		let pid = 0;
		const running = () => {
			try { const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return !["Z", "X"].includes(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0]); }
			catch { return false; }
		};
		try {
			const until = Date.now() + 1_000;
			while (Date.now() < until) {
				try { pid = Number(fs.readFileSync(file, "utf8").trim()); } catch { /* not created yet */ }
				if (pid && child.exitCode === 0) break;
				await delay(10);
			}
			expect(pid).toBeGreaterThan(1); expect(child.exitCode).toBe(0); expect(running()).toBe(true);
			killTree(child, "SIGKILL", true);
			const end = Date.now() + 1_000;
			while (running() && Date.now() < end) await delay(10);
			expect(running()).toBe(false);
		} finally {
			killTree(child, "SIGKILL", true); child.stdout.destroy(); child.stderr.destroy();
			if (pid > 1 && running()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
