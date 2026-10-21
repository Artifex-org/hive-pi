import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runTests } from "../../scripts/test.ts";
import { markRunner } from "../../scripts/test-temp.ts";

const self = fileURLToPath(import.meta.url);
if (process.argv[2] !== "worker") {
	process.exitCode = await runTests(self, ["worker", ...process.argv.slice(3)], process.argv[2]);
} else {
	const [mode, state] = process.argv.slice(3);
	markRunner(process.env.HIVE_PI_TEST_RUN_DIR!);
	const artifact = mkdtempSync(join(tmpdir(), "fixture-"));
	writeFileSync(join(artifact, "data"), "owned");
	let descendant: number | undefined;
	let nested: { wrapper: number; pid: number; descendant: number; artifact: string; run: string } | undefined;
	if (mode === "nested-reader") {
		const nestedState = join(artifact, "nested-state");
		const child = spawn(process.execPath, [self, join(artifact, "roots"), "registered-reader", nestedState], { stdio: "ignore" });
		for (let i = 0; i < 200 && !existsSync(nestedState); i++) await delay(25);
		nested = { ...JSON.parse(readFileSync(nestedState, "utf8")), wrapper: child.pid };
	}
	if (["orphan", "fd-reader", "cwd-reader", "socket-reader", "registered-reader"].includes(mode)) {
		const fd = mode === "fd-reader" ? openSync(join(artifact, "data"), "r") : undefined;
		const source = mode === "registered-reader"
			? `import(${JSON.stringify(new URL("../../scripts/test-temp.ts", import.meta.url).href)}).then(({registerReader})=>{registerReader(${JSON.stringify(process.env.HIVE_PI_TEST_RUN_DIR)});require("node:fs").writeFileSync(${JSON.stringify(join(artifact, "ready"))},"ready");setInterval(()=>{},1000)})`
			: mode === "socket-reader"
			? `require("node:net").createServer(s=>s.end("escaped")).listen(${JSON.stringify(join(artifact, "s"))},()=>require("node:fs").writeFileSync(${JSON.stringify(join(artifact, "ready"))},"ready"))`
			: "setInterval(()=>{},1000)";
		const child = spawn(process.execPath, ["-e", source], {
			detached: true,
			env: mode === "orphan" ? process.env : {},
			cwd: mode === "cwd-reader" ? artifact : "/",
			stdio: fd === undefined ? "ignore" : ["ignore", "ignore", "ignore", fd],
		});
		if (fd !== undefined) closeSync(fd);
		descendant = child.pid;
		child.unref();
		if (mode === "socket-reader" || mode === "registered-reader") {
			for (let i = 0; i < 100 && !existsSync(join(artifact, "ready")); i++) await delay(25);
			if (!existsSync(join(artifact, "ready"))) throw new Error("Socket reader did not start");
		}
	}
	if (mode === "socket") {
		const server = createServer(socket => socket.end("live"));
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(artifact, "s"), resolve); });
	}
	writeFileSync(state, JSON.stringify({ pid: process.pid, descendant, nested, artifact, tmp: tmpdir(), run: process.env.HIVE_PI_TEST_RUN_DIR, compile: process.env.NODE_COMPILE_CACHE }));
	if (["hang", "orphan", "fd-reader", "cwd-reader", "socket-reader", "registered-reader", "nested-reader", "stubborn"].includes(mode)) {
		if (mode === "stubborn") process.on("SIGTERM", () => {});
		setInterval(() => {}, 1000);
	} else {
		if (mode === "bad-root") chmodSync(dirname(process.env.HIVE_PI_TEST_RUN_DIR!), 0o755);
		process.exitCode = mode === "fail" ? 7 : 0;
	}
}
