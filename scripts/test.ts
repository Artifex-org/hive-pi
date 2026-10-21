/** npm test entrypoint: establish temp ownership before Node/Vite/Vitest startup. */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { killTree, releaseTree, trackTree, treeSpawnOptions, TREE_TOKEN } from "../extensions/hive-common/child-tree.ts";
import { cleanRun, createRun, recoverRuns, tempRoot } from "./test-temp.ts";

export async function runTests(worker: string, args: string[], root = tempRoot()): Promise<number> {
	recoverRuns(root);
	const options = { ...treeSpawnOptions(process.env), detached: true };
	const token = options.env[TREE_TOKEN]!.split(",").at(-1)!;
	const run = createRun(root, token);
	const tmp = join(run.path, "tmp");
	const child = spawn(process.execPath, [worker, ...args], {
		...options,
		stdio: "inherit",
		env: { ...options.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, NODE_COMPILE_CACHE: join(tmp, "compile-cache"), HIVE_PI_TEST_RUN_DIR: run.path,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./test-reader.ts", import.meta.url).href}` },
	});
	trackTree(child, options.detached, options.env[TREE_TOKEN]);
	let received: NodeJS.Signals | undefined;
	let escalation: NodeJS.Timeout | undefined;
	let cleanupError: unknown;
	const signal = (value: NodeJS.Signals) => {
		received ??= value;
		try { killTree(child, value, options.detached); } catch (error) { cleanupError = error; }
		escalation ??= setTimeout(() => {
			try { killTree(child, "SIGKILL", options.detached); } catch (error) { cleanupError = error; }
		}, 1500);
	};
	const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(value => [value, () => signal(value as NodeJS.Signals)]));
	for (const [name, handler] of handlers) process.on(name, handler);
	try {
		const result = await new Promise<number>(resolve => {
			child.once("error", error => { console.error(error.message); resolve(1); });
			child.once("close", (code, signaled) => resolve(code ?? 128 + (constants.signals[signaled ?? "SIGTERM"] ?? 1)));
		});
		try { killTree(child, "SIGKILL", options.detached); releaseTree(child); } catch (error) { cleanupError = error; }
		let cleaned = false;
		let failedCleanup = cleanupError !== undefined;
		let reason = String(cleanupError ?? "cleanup not attempted");
		if (!cleanupError) {
			for (let attempt = 0; attempt < 20; attempt++) {
				const cleanup = cleanRun(root, run.path, token);
				reason = cleanup.reason;
				if (cleanup.status === "removed") { cleaned = true; break; }
				if (cleanup.status === "error") { failedCleanup = true; break; }
				await delay(50);
			}
		}
		if (!cleaned) console.error(`Test temporary run retained (${reason}): ${run.path}`);
		return received ? 128 + constants.signals[received] : result || (failedCleanup || (!cleaned && process.platform === "linux") ? 1 : 0);
	} finally {
		if (escalation) clearTimeout(escalation);
		for (const [name, handler] of handlers) process.off(name, handler);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try { process.exitCode = await runTests(fileURLToPath(new URL("./test-worker.ts", import.meta.url)), process.argv.slice(2)); }
	catch (error) { console.error(String(error)); process.exitCode = 1; }
}
