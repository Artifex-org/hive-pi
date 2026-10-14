import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { acquireGateLease, type GateLease } from "../extensions/agenda/gate-lease.ts";

const dirs: string[] = [];
const leases: GateLease[] = [];
afterEach(async () => {
	for (const lease of leases.splice(0)) await lease.release();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "gate-lease-")); dirs.push(dir);
	const one = join(dir, "one"), two = join(dir, "two"); mkdirSync(one); mkdirSync(two);
	return { one, two, options: { directory: join(dir, "leases"), slots: 1 } };
}
async function own(lease: Promise<GateLease | null>) {
	const value = await lease; expect(value).not.toBeNull(); leases.push(value!); return value!;
}

describe("cross-process automatic gate admission", () => {
	it("canonicalizes symlinks and refuses another lease on the same worktree", async () => {
		const { one, options } = fixture();
		const alias = `${one}-link`; symlinkSync(one, alias);
		await own(acquireGateLease(one, () => Date.now() + 1_000, undefined, options));
		expect(await acquireGateLease(alias, () => Date.now() + 1_000, undefined, options)).toBeNull();
	});

	it("bounds host-wide automatic concurrency and admits a waiter after release", async () => {
		const { one, two, options } = fixture();
		const first = await own(acquireGateLease(one, () => Date.now() + 1_000, undefined, options));
		const end = Date.now() + 2_000;
		let admitted = false;
		const next = own(acquireGateLease(two, () => end, undefined, options)).then((lease) => { admitted = true; return lease; });
		await new Promise((r) => setTimeout(r, 150)); expect(admitted).toBe(false);
		await first.release();
		await next; expect(admitted).toBe(true);
	});

	it("admission deadline and abort release the worktree lease without claiming a verdict", async () => {
		const { one, two, options } = fixture();
		const first = await own(acquireGateLease(one, () => Date.now() + 1_000, undefined, options));
		const end = Date.now() + 100;
		expect(await acquireGateLease(two, () => end, undefined, options)).toBeNull();
		const controller = new AbortController();
		const waiting = acquireGateLease(two, () => Date.now() + 1_000, controller.signal, options);
		controller.abort(); expect(await waiting).toBeNull();
		await first.release();
		await own(acquireGateLease(two, () => Date.now() + 1_000, undefined, options));
	});

	it("attempt receipts survive releases, and a dead owner's heartbeat lock expires", async () => {
		const { one, options } = fixture();
		const first = await own(acquireGateLease(one, () => Date.now() + 1_000, undefined, options));
		await first.write({ input: "input-at-spawn", outcome: "running" }); await first.release();
		const key = createHash("sha256").update(realpathSync(one)).digest("hex");
		const lock = join(options.directory, `${key}.lock`);
		mkdirSync(lock); const past = new Date(Date.now() - 60_000); utimesSync(lock, past, past);
		const second = await own(acquireGateLease(one, () => Date.now() + 1_000, undefined, options));
		expect(await second.read()).toEqual({ input: "input-at-spawn", outcome: "running" });
		await second.write({ input: "input-at-spawn", outcome: "incomplete" });
		expect(await second.read()).toEqual({ input: "input-at-spawn", outcome: "incomplete" });
	});
});
