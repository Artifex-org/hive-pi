import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../extensions/toolcwd/cwd.ts";
import { registerReader } from "../scripts/test-temp.ts";
import { TREE_TOKEN } from "../extensions/hive-common/child-tree.ts";

/** Keep hermetic child environments inside the test run's lifetime scope. */
export function testTempEnv(): Record<string, string> {
	const env: Record<string, string> = { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() };
	for (const key of [TREE_TOKEN, "NODE_COMPILE_CACHE", "NODE_OPTIONS", "HIVE_PI_TEST_RUN_DIR"]) {
		if (process.env[key]) env[key] = process.env[key]!;
	}
	return env;
}

/** Native escape fixtures admit the shell before it reads/writes run artifacts. */
export function readerAdmissionCommand(): string {
	const run = process.env.HIVE_PI_TEST_RUN_DIR;
	return run ? `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("../scripts/test-reader.ts", import.meta.url)))} ${shellQuote(run)} "$$"` : ":";
}
export function registerTestReader(pid: number | undefined): void {
	if (!process.env.HIVE_PI_TEST_RUN_DIR) return;
	if (pid === undefined) throw new Error("Test reader did not spawn");
	registerReader(process.env.HIVE_PI_TEST_RUN_DIR, pid);
}
