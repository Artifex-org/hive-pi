import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync } from "node:fs";
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

async function contender(root: string, directory: string) {
	const marker = join(root, `execution-${workers.length}`);
	const source = `
		import { acquireGateLease } from ${JSON.stringify(new URL("../extensions/agenda/gate-lease.ts", import.meta.url).href)};
		import { writeFile } from 'node:fs/promises';
		const end = Date.now() + 300;
		const lease = await acquireGateLease(process.argv[1], () => end, undefined, { directory: process.argv[2], slots: 2 });
		if (!lease) console.log('blocked');
		else {
			const release = new Promise(resolve => process.stdin.once('data', resolve));
			await writeFile(process.argv[3], 'executing');
			console.log('admitted');
			await release;
			await lease.release();
		}
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", source, root, directory, marker], { stdio: ["pipe", "pipe", "pipe"] });
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
