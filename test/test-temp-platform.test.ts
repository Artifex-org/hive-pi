import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { runTests } from "../scripts/test.ts";

it("does not mask a real cleanup error as unsupported-platform retention", async () => {
	const base = mkdtempSync(join(tmpdir(), "p-"));
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	const errors: string[] = [];
	const log = vi.spyOn(console, "error").mockImplementation(value => { errors.push(String(value)); });
	try {
		Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
		const code = await runTests(fileURLToPath(new URL("./fixtures/test-temp-worker.ts", import.meta.url)), ["worker", "bad-root", join(base, "state")], join(base, "runs"));
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("must be private");
	} finally {
		Object.defineProperty(process, "platform", descriptor);
		log.mockRestore();
		rmSync(base, { recursive: true, force: true });
	}
});
