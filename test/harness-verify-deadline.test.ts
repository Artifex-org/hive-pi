import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { treeStamp } from "../extensions/harness/verify.ts";

function running(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
	} catch { return false; }
}

describe.runIf(process.platform === "linux")("fingerprint subprocess wall budget", () => {
	it.each(["deadline", "abort"] as const)("bounds %s across parallel git helpers and kills their output-holding children", async mode => {
		const dir = mkdtempSync(join(tmpdir(), "stamp-deadline-"));
		const tools = join(dir, "tools"), marker = join(dir, "pids"), tag = dir.split("/").at(-1)!;
		mkdirSync(tools);
		const git = join(tools, "git");
		writeFileSync(git, `#!/bin/bash\n/bin/bash -c 'exec -a ${tag} /bin/sleep 5' &\nprintf '%s\\n' "$$ $!" >> ${JSON.stringify(marker)}\nwait\n`);
		chmodSync(git, 0o755);
		vi.stubEnv("PATH", `${tools}${delimiter}${process.env.PATH}`);
		const controller = new AbortController();
		const abort = mode === "abort" ? setTimeout(() => controller.abort(), 500) : undefined;
		const pids = () => existsSync(marker) ? readFileSync(marker, "utf8").trim().split(/\s+/).map(Number) : [];
		try {
			const start = Date.now();
			expect(await treeStamp(dir, "commit", { signal: controller.signal, deadline: mode === "deadline" ? start + 500 : undefined })).toBeNull();
			expect(Date.now() - start).toBeLessThan(2_000); // includes bounded cleanup, not another 5s wait
			expect(pids()).toHaveLength(8); // four actual git helpers, each with a child
			const goneBy = Date.now() + 500;
			while (pids().some(running) && Date.now() < goneBy) await new Promise(resolve => setTimeout(resolve, 10));
			expect(pids().filter(running)).toEqual([]);
		} finally {
			clearTimeout(abort); vi.unstubAllEnvs();
			for (const pid of pids()) {
				try {
					const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
					if (command.includes(tag) || command.includes(tools)) process.kill(pid, "SIGKILL");
				} catch { /* already gone; never signal a reused unrelated PID */ }
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
