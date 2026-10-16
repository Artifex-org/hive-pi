import { constants } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { claimPilotAttempt } from "../extensions/claude-sdk/pilot-latch.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function config() { const stateRoot = await mkdtemp(join(tmpdir(), "sdk-latch-")); roots.push(stateRoot); return { stateRoot, launch: "offline" }; }
it("atomically admits one concurrent attempt, writes no payload, and persists across a fresh process", async () => {
	const cfg = await config();
	const attempts = await Promise.allSettled([claimPilotAttempt(cfg), claimPilotAttempt(cfg)]);
	expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
	const path = join(cfg.stateRoot, "pilot-offline.attempt");
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ protocol: 1, consumed: true });
	const module = new URL("../extensions/claude-sdk/pilot-latch.ts", import.meta.url).href;
	const script = "import { claimPilotAttempt } from " + JSON.stringify(module) + "; " +
		"try { await claimPilotAttempt(" + JSON.stringify(cfg) + "); process.exitCode=2; } " +
		"catch(error) { process.exitCode=error.code==='EEXIST'?0:1; }";
	await promisify(execFile)(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], { timeout: 5_000 });
	await expect(claimPilotAttempt(cfg)).rejects.toMatchObject({ code: "EEXIST" });
});
it("refuses a preexisting or symlink latch without modifying its destination", async () => {
	const cfg = await config();
	const target = join(cfg.stateRoot, "target");
	await symlink(target, join(cfg.stateRoot, "pilot-offline.attempt"));
	await expect(claimPilotAttempt(cfg)).rejects.toMatchObject({ code: "EEXIST" });
	await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses an unsafe state root rather than chmod or bypass it", async () => {
	const cfg = await config(); await chmod(cfg.stateRoot, 0o755);
	await expect(claimPilotAttempt(cfg)).rejects.toThrow("owned, non-symlink 0700");
	expect((await stat(cfg.stateRoot)).mode & 0o777).toBe(0o755);
	expect(constants.O_EXCL).toBeGreaterThan(0);
});
