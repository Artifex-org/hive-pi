import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("npm test contains the original fixture leaks and preserves Vitest startup failure", () => {
	const base = mkdtempSync(join(tmpdir(), "e-"));
	const root = join(base, "runs");
	const ambient = join(base, "ambient");
	mkdirSync(ambient);
	try {
		// npm enables its own compile cache before reading package scripts.
		const env = { ...process.env, NODE_COMPILE_CACHE: join(base, "npm-cache"), HIVE_PI_TEST_TMP_ROOT: root, TMPDIR: ambient, TMP: ambient, TEMP: ambient };
		const success = spawnSync("npm", ["test", "--", "test/background-indexlock.test.ts", "test/claude-units.test.ts", "test/gate-findgate.test.ts"], { env, encoding: "utf8", timeout: 25000 });
		expect(success.status, success.stdout + success.stderr).toBe(0);
		expect(success.stdout).toMatch(/35 passed/);
		if (process.platform === "linux") expect(readdirSync(root)).toEqual([]);
		expect(readdirSync(ambient)).toEqual([]);
		const failure = spawnSync("npm", ["test", "--", "--not-a-vitest-option"], { env, encoding: "utf8", timeout: 10000 });
		expect(failure.status, failure.stdout + failure.stderr).toBe(1);
		expect(failure.stderr).toContain("Unknown option");
		if (process.platform === "linux") expect(readdirSync(root)).toEqual([]);
		expect(readdirSync(ambient)).toEqual([]);
	} finally { rmSync(base, { recursive: true, force: true }); }
}, 40000);
