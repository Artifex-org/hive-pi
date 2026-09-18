/**
 * `runOneShot` passes `--thinking` to the child only when asked.
 *
 * The goal judge's timeouts were a reasoning pass inherited from the user's
 * `defaultThinkingLevel`; the fix depends on the flag actually reaching the
 * child. A fake `pi` (via the documented PI_HOUSE_PI_BIN override) echoes its
 * argv back as the assistant message, so the assertion is on what the child
 * received — not on what we meant to send.
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runOneShot } from "../extensions/agenda/spawn.ts";

let previous: string | undefined;

beforeEach(() => {
	previous = process.env.PI_HOUSE_PI_BIN;
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	const bin = join(dir, "pi");
	writeFileSync(
		bin,
		`#!${process.execPath}\n` +
			"const argv = process.argv.slice(2);\n" +
			'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: JSON.stringify(argv) } }));\n',
	);
	chmodSync(bin, 0o755);
	process.env.PI_HOUSE_PI_BIN = bin;
});

afterEach(() => {
	if (previous === undefined) delete process.env.PI_HOUSE_PI_BIN;
	else process.env.PI_HOUSE_PI_BIN = previous;
});

describe("runOneShot --thinking", () => {
	it("passes the level when one is given", async () => {
		const out = await runOneShot({ prompt: "p", model: "m/x", cwd: tmpdir(), timeoutMs: 10_000, thinking: "off" });
		const argv = JSON.parse(out.text) as string[];
		expect(argv).toContain("--thinking");
		expect(argv[argv.indexOf("--thinking") + 1]).toBe("off");
	});

	it("passes nothing when none is given, so the user's default still applies", async () => {
		const out = await runOneShot({ prompt: "p", model: "m/x", cwd: tmpdir(), timeoutMs: 10_000 });
		expect(JSON.parse(out.text)).not.toContain("--thinking");
	});
});
