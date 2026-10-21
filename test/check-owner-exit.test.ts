import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readerAdmissionCommand } from "./temp-env.ts";

function identity(pid: number) {
	try {
		const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
		return { start: fields[19], running: !["Z", "X"].includes(fields[0]) };
	} catch { return undefined; }
}
async function waitFor(test: () => boolean, ms = 3_000) {
	const end = Date.now() + ms;
	while (!test() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
	expect(test()).toBe(true);
}
describe.runIf(process.platform === "linux")("non-helper check owner shutdown", () => {
	it.each(["exit", "SIGTERM", "SIGHUP", "SIGINT"] as const)("reaps a detached check on owner %s", async mode => {
		const dir = mkdtempSync(join(tmpdir(), "check-owner-exit-")), marker = join(dir, "pid"), extraMarker = join(dir, "extra"), quit = join(dir, "quit");
		const source = pathToFileURL(resolve("extensions/agenda/gate.ts")).href;
		const command = `${readerAdmissionCommand()} || exit; printf '%s' "$$" > '${marker}'; exec sleep 20`;
		const replica = pathToFileURL(resolve("extensions/hive-common/child-tree.ts")).href + "?replica";
		const code = `import {runCheck} from ${JSON.stringify(source)};
			import {spawn} from 'node:child_process'; import {existsSync, writeFileSync} from 'node:fs';
			import {registerTestReader} from ${JSON.stringify(pathToFileURL(resolve("test/temp-env.ts")).href)};
			const other = await import(${JSON.stringify(replica)}), options = other.treeSpawnOptions();
			const extra = spawn('sleep', ['20'], {...options, detached:true, stdio:'ignore'});
			registerTestReader(extra.pid);
			other.trackTree(extra, true, options.env[other.TREE_TOKEN]); writeFileSync(${JSON.stringify(extraMarker)}, String(extra.pid));
			${mode === "exit" ? `setInterval(()=>{if(existsSync(${JSON.stringify(quit)}))process.exit(0);},10);` : ""}
			await runCheck(${JSON.stringify(command)}, ${JSON.stringify(dir)}, 60000);`;
		const env = { ...process.env, HIVE_PI_HELPER_CHILD: "", HIVE_PI_TREE_TOKENS: "" };
		const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { detached: true, env, stdio: "ignore" });
		const ended = new Promise(resolve => owner.once("exit", resolve));
		const children = new Map<number, string>();
		try {
			await waitFor(() => existsSync(marker) && existsSync(extraMarker));
			for (const path of [marker, extraMarker]) {
				const pid = Number(readFileSync(path, "utf8")), birth = identity(pid)?.start;
				expect(pid).toBeGreaterThan(0); expect(birth).toBeTypeOf("string"); children.set(pid, birth!);
			}
			if (mode !== "exit") process.kill(-owner.pid!, mode);
			else writeFileSync(quit, "exit");
			await ended;
			if (mode !== "exit") expect(owner.signalCode).toBe(mode);
			await waitFor(() => [...children.keys()].every(pid => !identity(pid)?.running), 700);
		} finally {
			if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
			for (const [pid, birth] of children) if (identity(pid)?.start === birth) {
				try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
			}
			await ended; rmSync(dir, { recursive: true, force: true });
		}
	});
});
