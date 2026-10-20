/**
 * session-context in a Hive task launch: no hook frontload, the handoff seed
 * still delivered.
 *
 * The hook is the operator's Claude Code SessionStart script. In a launch its
 * infrastructure pack, other agents' worktrees and a stale PR list cost ~13k
 * characters (HIV-3906 eval) and told the task nothing it needed; a successor
 * launch's handoff seed has no other way in.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePi } from "./fake-pi.ts";

/** A HOME whose session-context hook prints a recognisable pack. */
function fakeHome(): string {
	const home = mkdtempSync(join(tmpdir(), "hive-pi-session-context-"));
	const hooks = join(home, ".claude", "hooks");
	mkdirSync(hooks, { recursive: true });
	const hook = join(hooks, "session-context.sh");
	writeFileSync(hook, `#!/bin/bash\necho '{"continue":true,"additionalContext":"INFRA PACK: kubectl --context=everything"}'\n`);
	chmodSync(hook, 0o755);
	return home;
}

/** A non-git directory holding a legacy handoff seed. */
function cwdWithSeed(): string {
	const cwd = mkdtempSync(join(tmpdir(), "hive-pi-session-context-cwd-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "handoff.md"), "HANDOFF SEED: continue the migration\n");
	return cwd;
}

async function firstMessage(launchId: string): Promise<string | undefined> {
	vi.stubEnv("HOME", fakeHome());
	vi.stubEnv("HIVE_LAUNCH_ID", launchId);
	vi.stubEnv("PI_AGENDA_WORKER", "");
	vi.resetModules();
	const { default: sessionContext } = await import("../extensions/session-context.ts");
	const pi = createFakePi();
	sessionContext(pi.api);
	const cwd = cwdWithSeed();
	await pi.emit({ type: "session_start", reason: "startup" }, { cwd, mode: "tui" });
	const results = (await pi.emit({ type: "before_agent_start", prompt: "go" } as never, { cwd, mode: "tui" })) as Array<
		{ message?: { content: string } } | undefined
	>;
	return results.find((result) => result?.message)?.message?.content;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("session-context", () => {
	it("frontloads the hook's pack and the handoff seed in an operator's own session", async () => {
		const content = await firstMessage("");
		expect(content).toContain("INFRA PACK");
		expect(content).toContain("HANDOFF SEED");
	});

	it("skips the hook in a Hive task launch but still delivers the handoff seed", async () => {
		const content = await firstMessage("f7ac2065-7b82-44be-a3c1-0cf0f97127b2");
		expect(content).not.toContain("INFRA PACK");
		expect(content).toContain("HANDOFF SEED");
	});
});
