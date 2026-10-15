import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { acquireGateLease, type GateLease } from "../extensions/agenda/gate-lease.ts";

const dirs: string[] = [];
const leases: GateLease[] = [];
const workers: { child: ChildProcessWithoutNullStreams; closed: Promise<void> }[] = [];
afterEach(async () => {
	await Promise.all(workers.splice(0).map(async ({ child, closed }) => {
		child.kill("SIGTERM");
		const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
		try { await closed; } finally { clearTimeout(force); }
	}));
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

async function contender(root: string, directory?: string, env: NodeJS.ProcessEnv = {}) {
	const marker = join(root, `execution-${workers.length}`);
	const source = `
		import { acquireGateLease } from ${JSON.stringify(new URL("../extensions/agenda/gate-lease.ts", import.meta.url).href)};
		import { writeFile } from 'node:fs/promises';
		// Isolate the DEFAULT-directory test from real users' slots without
		// changing its directory selection: an impossible negative uid namespace.
		if (process.env.GATE_TEST_UID) process.getuid = () => Number(process.env.GATE_TEST_UID);
		const end = Date.now() + 300;
		const lease = await acquireGateLease(process.argv[1], () => end, undefined, { directory: process.argv[2] || undefined, slots: 2 });
		if (!lease) console.log('blocked');
		else {
			const release = new Promise(resolve => process.stdin.once('data', resolve));
			await writeFile(process.argv[3], 'executing');
			console.log('admitted');
			await release;
			if (process.env.GATE_WRITE_PASS) await lease.write({ input: "old", outcome: "pass" });
			await lease.release();
		}
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", source, root, directory ?? "", marker], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
	const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
	workers.push({ child, closed });
	let stderr = "";
	child.stderr.on("data", data => { stderr += String(data); });
	const lines = createInterface({ input: child.stdout });
	let timer: ReturnType<typeof setTimeout>;
	try {
		const state = await new Promise<string>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`contender did not publish readiness: ${stderr}`)), 5_000);
			lines.once("line", resolve);
			child.once("error", reject);
			void closed.then(() => reject(new Error(`contender exited before readiness: ${stderr}`)));
		});
		return { child, closed, marker, state };
	} finally { clearTimeout(timer!); }
}

describe("cross-process automatic gate admission", () => {
	it.runIf(process.platform === "linux")("keeps metadata ownership through suspension and resumed writes, not heartbeat age", async () => {
		const { one, options } = fixture();
		const first = await contender(one, options.directory, { GATE_WRITE_PASS: "1" });
		expect(first.state).toBe("admitted");
		first.child.kill("SIGSTOP");
		let blocked = false;
		const failure = { input: "new", outcome: "fail" as const, notice: "successor failed", noticeId: "new", charge: true as const };
		try {
			const old = new Date(Date.now() - 31_000);
			for (const entry of readdirSync(options.directory)) if (entry.endsWith(".lock")) utimesSync(join(options.directory, entry), old, old);
			const successor = await acquireGateLease(one, () => Date.now() + 500, undefined, { ...options, deferSlot: true });
			blocked = successor === null;
			if (successor) { await successor.write(failure); await successor.release(); }
		} finally {
			first.child.kill("SIGCONT"); first.child.stdin.end("resume and write\n"); await first.closed;
		}
		const successor = await own(acquireGateLease(one, () => Date.now() + 500, undefined, { ...options, deferSlot: true }));
		if (blocked) await successor.write(failure);
		expect(await successor.read()).toEqual(failure);
		expect(blocked).toBe(true); // no stale writer can publish after a successor
	});
	it("excludes independent processes by root and two host slots, then recovers after release and holder termination", async () => {
		const { one, two, options } = fixture();
		const three = `${one}-third`; mkdirSync(three);
		const first = await contender(one, options.directory);
		expect(first.state).toBe("admitted");
		const duplicate = await contender(one, options.directory);
		expect(duplicate.state).toBe("blocked"); expect(existsSync(duplicate.marker)).toBe(false);
		const second = await contender(two, options.directory);
		expect(second.state).toBe("admitted");
		const saturated = await contender(three, options.directory);
		expect(saturated.state).toBe("blocked"); expect(existsSync(saturated.marker)).toBe(false);
		first.child.stdin.end("release\n"); await first.closed;
		expect((await contender(three, options.directory)).state).toBe("admitted");
		second.child.kill("SIGTERM"); await second.closed;
		expect((await contender(two, options.directory)).state).toBe("admitted");
	}, 15_000);

	it.runIf(process.platform !== "win32")("coordinates default admission across distinct process TMPDIR values", async () => {
		const { one, two } = fixture();
		const tmpOne = join(one, "tmp"), tmpTwo = join(two, "tmp"); mkdirSync(tmpOne); mkdirSync(tmpTwo);
		const uid = String(-process.pid); // no real user can own this uid
		dirs.push(join("/tmp", `hive-pi-auto-gates-${uid}`));
		expect((await contender(one, undefined, { TMPDIR: tmpOne, GATE_TEST_UID: uid })).state).toBe("admitted");
		const duplicate = await contender(one, undefined, { TMPDIR: tmpTwo, GATE_TEST_UID: uid });
		expect(duplicate.state).toBe("blocked"); expect(existsSync(duplicate.marker)).toBe(false);
		expect((await contender(two, undefined, { TMPDIR: tmpTwo, GATE_TEST_UID: uid })).state).toBe("admitted");
		const third = join(two, "third"); mkdirSync(third);
		const overCapacity = await contender(third, undefined, { TMPDIR: tmpOne, GATE_TEST_UID: uid });
		expect(overCapacity.state).toBe("blocked"); expect(existsSync(overCapacity.marker)).toBe(false);
	});

	it.runIf(process.platform !== "win32").each(["shared", "symlink"])("rejects a %s coordination directory instead of trusting public state", async kind => {
		const { one, options } = fixture();
		if (kind === "shared") { mkdirSync(options.directory); chmodSync(options.directory, 0o777); }
		else symlinkSync(one, options.directory, "dir");
		const attempt = acquireGateLease(one, () => Date.now() + 1_000, undefined, options);
		try { await expect(attempt).rejects.toThrow(); }
		finally { await (await attempt.catch(() => null))?.release(); }
	});

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
