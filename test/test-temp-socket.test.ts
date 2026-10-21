import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { cleanRun, prepareRoot, recoverRuns } from "../scripts/test-temp.ts";

it("recovery preserves unrelated and concurrent live Unix sockets", async () => {
	const base = mkdtempSync(join(tmpdir(), "s-"));
	const root = join(base, "r");
	prepareRoot(root);
	const unrelated = join(root, "unrelated.sock");
	const server = createServer(socket => socket.end("unrelated"));
	const read = (path: string) => new Promise<string>((resolve, reject) => {
		const socket = createConnection(path);
		let data = "";
		socket.on("data", chunk => { data += chunk; });
		socket.once("end", () => resolve(data));
		socket.once("error", reject);
	});
	const fixture = fileURLToPath(new URL("./fixtures/test-temp-worker.ts", import.meta.url));
	let child: ReturnType<typeof spawn> | undefined;
	let done: Promise<unknown> | undefined;
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(unrelated, resolve); });
		const stateFile = join(base, "state");
		child = spawn(process.execPath, [fixture, root, "socket", stateFile], { stdio: "ignore" });
		done = new Promise(resolve => child!.once("close", resolve));
		for (let attempt = 0; attempt < 200 && !existsSync(stateFile); attempt++) await delay(25);
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		recoverRuns(root);
		expect(await read(unrelated)).toBe("unrelated");
		expect(await read(join(state.artifact, "s"))).toBe("live");
		child.kill("SIGTERM");
		await done;
		expect(await read(unrelated)).toBe("unrelated");
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await done;
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(base, { recursive: true, force: true });
	}
});

it("protects an env-cleared detached socket reader after wrapper SIGKILL", async () => {
	const base = mkdtempSync(join(tmpdir(), "s-"));
	const root = join(base, "r  s");
	const stateFile = join(base, "state");
	const fixture = fileURLToPath(new URL("./fixtures/test-temp-worker.ts", import.meta.url));
	const child = spawn(process.execPath, [fixture, root, "socket-reader", stateFile], { stdio: "ignore" });
	const done = new Promise(resolve => child.once("exit", resolve));
	let state: { pid: number; descendant: number; artifact: string; run: string } | undefined;
	try {
		for (let i = 0; i < 200 && !existsSync(stateFile); i++) await delay(25);
		state = JSON.parse(readFileSync(stateFile, "utf8"));
		child.kill("SIGKILL");
		await done;
		process.kill(state!.pid, "SIGKILL");
		await delay(100);
		expect(cleanRun(root, state!.run).status).toBe("retained");
		expect(existsSync(join(state!.artifact, "s"))).toBe(true);
		process.kill(state!.descendant, 0);
		process.kill(state!.descendant, "SIGKILL");
		if (process.platform === "linux") {
			for (let i = 0; i < 100 && existsSync(state!.run); i++) { cleanRun(root, state!.run); await delay(25); }
			expect(existsSync(state!.run)).toBe(false);
		}
	} finally {
		child.kill("SIGKILL");
		for (const pid of state ? [state.pid, state.descendant] : []) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
		await done;
		await delay(50);
		rmSync(base, { recursive: true, force: true });
	}
});
