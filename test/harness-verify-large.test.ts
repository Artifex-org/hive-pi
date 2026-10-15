import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { treeStamp, writerMadeNoChange } from "../extensions/harness/verify.ts";

it("streams a tracked diff larger than 32MiB without disabling no-change detection", async () => {
	const root = mkdtempSync(join(tmpdir(), "stamp-large-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, stdio: "ignore" });
	try {
		git("init", "-q");
		writeFileSync(join(root, "large.txt"), "a".repeat(18 * 1024 * 1024) + "\n");
		git("add", "."); git("commit", "-qm", "base");
		const before = await treeStamp(root);
		writeFileSync(join(root, "large.txt"), "b".repeat(18 * 1024 * 1024) + "\n");
		const after = await treeStamp(root);
		expect(before).not.toBeNull(); expect(after).not.toBeNull(); expect(after).not.toBe(before);
		expect(writerMadeNoChange(after, await treeStamp(root))).toBe(true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
