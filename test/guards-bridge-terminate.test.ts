/**
 * `guards-bridge`'s tool_call VERDICT, driven through the fake pi.
 *
 * The extension that decides whether a tool runs had no wiring test — its
 * verdict is a return value, and `fake-pi`'s `emit()` used to discard those, so
 * a test could only ever show that a guard ran and never WHAT it decided.
 *
 * The distinction pinned here is a judgement call and worth stating plainly:
 * `terminate` (pi 0.84.1) ends the agent's turn after a blocked batch, so
 * applying it to the wrong denial silently abandons work rather than saving a
 * model call.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createFakePi, type FakePi } from "./fake-pi.ts";

/**
 * ONE home, set BEFORE the extension is imported.
 *
 * `guards-bridge` resolves `HOOKS_DIR` from `$HOME` at module-load time, so a
 * per-test directory would be read once and then ignored — the hook PATH is
 * fixed for the process. Each test rewrites the script's contents instead,
 * which is what actually varies.
 */
const home = mkdtempSync(join(tmpdir(), "guards-home-"));
const originalHome = process.env.HOME;
process.env.HOME = home;

const guards = (await import("../extensions/guards-bridge.ts")).default;

let fake: FakePi;

/** Install a fake `pre-bash-dispatch.sh` that answers with the given JSON. */
function hookAnswers(json: string): void {
	const dir = join(home, ".claude", "hooks");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "pre-bash-dispatch.sh");
	writeFileSync(path, `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${json}\nJSON\n`, "utf8");
	chmodSync(path, 0o755);
}

beforeEach(() => {
	fake = createFakePi();
});

afterAll(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
});

describe("a denial the human issued", () => {
	it("terminates the turn — there is nothing left for the model to work out", async () => {
		hookAnswers('{"decision":"ask","message":"run kubectl against prod?"}');
		guards(fake.api);

		// confirm:false is the human saying no.
		const [verdict] = await fake.emit(
			{ type: "tool_call", toolName: "bash", input: { command: "kubectl delete ns prod" } },
			{ confirm: false },
		);

		expect(verdict).toMatchObject({ block: true, terminate: true });
		// Without terminate the block costs a follow-up model call whose only
		// useful output is "understood" — and whose likelier output is a
		// workaround for the thing just refused.
		expect((verdict as { reason: string }).reason).toContain("User declined");
	});

	it("does not terminate when the human approves", async () => {
		hookAnswers('{"decision":"ask","message":"proceed?"}');
		guards(fake.api);

		const [verdict] = await fake.emit(
			{ type: "tool_call", toolName: "bash", input: { command: "ls" } },
			{ confirm: true },
		);

		expect(verdict).toBeUndefined(); // allowed through, no verdict at all
	});
});

describe("a denial the GUARD issued", () => {
	// The judgement this file exists to pin. These blocks carry actionable
	// remediation, and the follow-up turn is where the agent retries correctly
	// and finishes the task. Terminating would convert a recoverable misstep
	// into an abandoned one — spending the saved model call many times over.
	it("blocks WITHOUT terminating, so the agent can act on the remediation", async () => {
		hookAnswers('{"decision":"block","reason":"use `git -C /abs/worktree` instead"}');
		guards(fake.api);

		const [verdict] = await fake.emit({
			type: "tool_call",
			toolName: "bash",
			input: { command: "git commit -am wip" },
		});

		expect(verdict).toMatchObject({ block: true });
		expect((verdict as { terminate?: boolean }).terminate).toBeUndefined();
		expect((verdict as { reason: string }).reason).toContain("git -C");
	});

	it("allows anything the hook does not object to", async () => {
		hookAnswers('{"decision":"allow"}');
		guards(fake.api);

		const [verdict] = await fake.emit({ type: "tool_call", toolName: "bash", input: { command: "ls" } });
		expect(verdict).toBeUndefined();
	});
});
