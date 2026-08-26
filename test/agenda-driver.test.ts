/**
 * The driver — the one injector.
 *
 * These are the assertions that make "exactly one thing re-enters the loop" a
 * property rather than an intention. They use a stub policy rather than the
 * real gate, so they test the driver's contract and not `bash`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installDriver } from "../extensions/agenda/driver.ts";
import { emptyLedger } from "../extensions/agenda/ledger.ts";
import type { Policy, PolicyWork } from "../extensions/agenda/policy.ts";
import agenda, { describe as describeAgenda } from "../extensions/agenda/index.ts";
import { assistantFailed, assistantSaid, createFakePi, type FakePi } from "./fake-pi.ts";
import { ensureBash } from "./bash-shim.ts";

/** A policy that always wants the settle and always injects. */
function alwaysInjects(name = "stub", text = "do the thing"): Policy {
	return {
		name,
		decide: (): PolicyWork => ({
			name,
			status: `working: ${name}`,
			run: async () => ({ metric: { outcome: "fail", value: 1 }, inject: text }),
		}),
	};
}

/** A policy that never wants the settle. */
function neverApplies(name = "quiet"): Policy {
	return { name, decide: () => null };
}

/** A policy that runs and reports, but has nothing to inject — a green gate. */
function runsButSilent(name = "silent"): Policy {
	return {
		name,
		decide: (): PolicyWork => ({
			name,
			status: "",
			run: async () => ({ metric: { outcome: "pass", value: 1 } }),
		}),
	};
}

// The /agenda-stop test drives a real gate, which spawns bash.
beforeAll(ensureBash);

let pi: FakePi;

beforeEach(() => {
	pi = createFakePi();
});

/**
 * Only the hive.metric channel — the contract these assertions pin. The driver
 * also rings the injection doorbell (hive.agenda.injection, HIV-1242), which is
 * additive by design and not this suite's subject.
 */
function metricEvents() {
	return pi.busEvents.filter((event) => event.name === "hive.metric");
}

describe("driver — one injection per settle", () => {
	it("injects exactly once when a policy asks to", async () => {
		installDriver(pi.api, { policies: [alwaysInjects()] });
		await pi.emit({ type: "agent_settled" });
		expect(pi.messages).toHaveLength(1);
	});

	it("stops at the first policy that INJECTS", async () => {
		installDriver(pi.api, {
			policies: [neverApplies("a"), alwaysInjects("b", "from b"), alwaysInjects("c", "from c")],
		});
		await pi.emit({ type: "agent_settled" });

		expect(pi.messages).toHaveLength(1);
		expect(pi.messages[0].content).toBe("from b");
		expect(metricEvents()).toHaveLength(1);
		expect((metricEvents()[0].payload as Record<string, unknown>).name).toBe("b");
	});

	it("CONTINUES past a policy that ran but had nothing to say", async () => {
		// The gate applies on every settle in a gated repo. Stopping at the first
		// policy that merely *wants* the settle would starve everything behind it
		// — a goal would never be judged in a repo with a `.pi/harness.json`.
		installDriver(pi.api, {
			policies: [runsButSilent("quiet-gate"), alwaysInjects("goal", "from goal")],
		});
		await pi.emit({ type: "agent_settled" });

		expect(pi.messages).toHaveLength(1);
		expect(pi.messages[0].content).toBe("from goal");
		// BOTH report — a green gate and a goal evaluation are both real events.
		expect(metricEvents().map((e) => (e.payload as Record<string, unknown>).name)).toEqual(["quiet-gate", "goal"]);
	});

	it("still injects nothing when every policy is silent", async () => {
		installDriver(pi.api, { policies: [runsButSilent("a"), runsButSilent("b")] });
		await pi.emit({ type: "agent_settled" });

		expect(pi.messages).toHaveLength(0);
		expect(metricEvents()).toHaveLength(2);
	});

	it("stays silent when no policy applies, and emits no metric", async () => {
		installDriver(pi.api, { policies: [neverApplies("a"), neverApplies("b")] });
		await pi.emit({ type: "agent_settled" });
		expect(pi.messages).toHaveLength(0);
		expect(metricEvents()).toHaveLength(0);
	});

	it("injects as a turn-triggering followUp", async () => {
		installDriver(pi.api, { policies: [alwaysInjects()] });
		await pi.emit({ type: "agent_settled" });
		expect(pi.messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});
});

describe("driver — re-entrancy", () => {
	it("ignores a settle raised from inside its own handler", async () => {
		// The real hazard: pi clears `_isAgentRunActive` BEFORE emitting settled,
		// and the injected turn emits settled again when it finishes. Without the
		// guard that is unbounded recursion.
		let reentered = false;
		const recursive: Policy = {
			name: "recursive",
			decide: (): PolicyWork => ({
				name: "recursive",
				status: "",
				run: async () => {
					if (!reentered) {
						reentered = true;
						await pi.emit({ type: "agent_settled" });
					}
					return { metric: { outcome: "fail", value: 1 }, inject: "again" };
				},
			}),
		};

		installDriver(pi.api, { policies: [recursive] });
		await pi.emit({ type: "agent_settled" });

		expect(reentered).toBe(true);
		expect(pi.messages).toHaveLength(1); // NOT 2
	});

	it("releases the guard so a later settle is served normally", async () => {
		installDriver(pi.api, { policies: [alwaysInjects()] });
		await pi.emit({ type: "agent_settled" });
		await pi.emit({ type: "agent_settled" });
		expect(pi.messages).toHaveLength(2);
	});

	it("does not wedge when a policy throws", async () => {
		const boom: Policy = {
			name: "boom",
			decide: (): PolicyWork => ({
				name: "boom",
				status: "",
				run: async () => {
					throw new Error("policy exploded");
				},
			}),
		};
		installDriver(pi.api, { policies: [boom] });
		await pi.emit({ type: "agent_settled" });

		// Swallowed, and the guard is released for the next settle.
		expect(pi.messages).toHaveLength(0);
		await pi.emit({ type: "agent_settled" });
		expect(pi.messages).toHaveLength(0);
	});
});

describe("driver — session replacement", () => {
	it("drops in-flight work when the session is replaced mid-await", async () => {
		const slow: Policy = {
			name: "slow",
			decide: (): PolicyWork => ({
				name: "slow",
				status: "",
				run: async () => {
					// The session turns over while this policy is working.
					await pi.emit({ type: "session_start", reason: "new" });
					return { metric: { outcome: "fail", value: 1 }, inject: "stale result" };
				},
			}),
		};

		installDriver(pi.api, { policies: [slow] });
		await pi.emit({ type: "agent_settled" });

		// The generation moved, so the result belongs to a session that is gone.
		expect(pi.messages).toHaveLength(0);
	});

	it("survives a ctx that is already stale on entry", async () => {
		installDriver(pi.api, { policies: [alwaysInjects()] });

		// The session was replaced between pi emitting the event and this handler
		// running, so the very first property read throws. Without the try/catch
		// around the ctx reads this propagates out of the handler and, because pi
		// awaits handlers serially, takes the rest of the chain down with it.
		// Resolves rather than rejecting, AND the handler returned no verdict —
		// `emit` now surfaces each handler's return value, so this says more than
		// the bare "did not throw" it used to.
		await expect(pi.emit({ type: "agent_settled" }, { staleCtx: true })).resolves.toEqual([undefined]);
		expect(pi.messages).toHaveLength(0);
	});
});

describe("driver — coexistence with other injectors", () => {
	it("stands down when a turn is already running", async () => {
		// The mutual exclusion between injectors. `sendMessage({triggerTurn:true})`
		// reaches `_runAgentPrompt`, which sets `_isAgentRunActive = true`
		// synchronously before its first await — so any extension that injected
		// earlier in this same serial settle chain has already made us non-idle.
		// `@narumitw/pi-goal` gates on exactly this; without the same check here,
		// agenda injects on top of whatever it did.
		installDriver(pi.api, { policies: [alwaysInjects()] });
		await pi.emit({ type: "agent_settled" }, { idle: false });

		expect(pi.messages).toHaveLength(0);
		// And the policy never ran, so nothing was charged.
		expect(metricEvents()).toHaveLength(0);
	});

	it("stands down when messages are already queued", async () => {
		installDriver(pi.api, { policies: [alwaysInjects()] });
		await pi.emit({ type: "agent_settled" }, { pendingMessages: true });
		expect(pi.messages).toHaveLength(0);
	});

	it("does not inject if the user starts typing while the policy works", async () => {
		// A gate can run for minutes. Re-checking at injection time is what stops
		// the result cutting into a turn the human started meanwhile.
		let idle = true;
		const slow: Policy = {
			name: "slow",
			decide: (): PolicyWork => ({
				name: "slow",
				status: "",
				run: async () => {
					idle = false; // human typed during the gate run
					return { metric: { outcome: "fail", value: 1 }, inject: "late result" };
				},
			}),
		};

		installDriver(pi.api, { policies: [slow] });
		// `idle` is read live by the fake, so it flips mid-run.
		await pi.emit({ type: "agent_settled" }, { get idle() { return idle; } } as never);

		expect(pi.messages).toHaveLength(0);
		// The gate still RAN and still reported — only the injection is dropped.
		expect(metricEvents()).toHaveLength(1);
	});
});

describe("driver — headless and worker modes", () => {
	it.each(["print", "json"] as const)("never injects in %s mode", async (mode) => {
		installDriver(pi.api, { policies: [alwaysInjects()] });
		await pi.emit({ type: "agent_settled" }, { mode });
		expect(pi.messages).toHaveLength(0);
	});

	it("is completely inert in a worker process", async () => {
		installDriver(pi.api, { policies: [alwaysInjects()], isWorker: true });
		await pi.emit({ type: "agent_settled" });
		expect(pi.messages).toHaveLength(0);
		expect(metricEvents()).toHaveLength(0);
	});

	it("still REGISTERS its handlers in a worker, rather than skipping registration", async () => {
		// The 2026-08-05 bug: a factory-time `if (!enabled) return` before
		// registration can never be undone, because the factory runs once. The
		// enabled test must live inside the handler.
		installDriver(pi.api, { policies: [alwaysInjects()], isWorker: true });
		expect(pi.handlers.get("agent_settled")?.length).toBe(1);
		expect(pi.handlers.get("session_start")?.length).toBe(1);
	});
});

describe("driver — the question guard", () => {
	it("cancels automatic re-entry when the last turn asked the user something", async () => {
		installDriver(pi.api, { policies: [alwaysInjects()] });
		await pi.emit({ type: "agent_settled" }, { branch: assistantSaid("Which branch should I target?") });

		expect(pi.messages).toHaveLength(0);
		// And the policy never ran, so nothing was charged to it.
		expect(metricEvents()).toHaveLength(0);
	});

	it("injects normally when the last turn was a statement", async () => {
		installDriver(pi.api, { policies: [alwaysInjects()] });
		await pi.emit({ type: "agent_settled" }, { branch: assistantSaid("Build is broken.") });
		expect(pi.messages).toHaveLength(1);
	});

	it("surfaces the blocked state, and clears it once the question is gone", async () => {
		const driver = installDriver(pi.api, { policies: [alwaysInjects()] });

		await pi.emit({ type: "agent_settled" }, { branch: assistantSaid("Proceed?") });
		expect(driver.blockedOnUser()).toBe(true);

		await pi.emit({ type: "agent_settled" }, { branch: assistantSaid("Proceeding.") });
		expect(driver.blockedOnUser()).toBe(false);
	});
});

describe("driver — status", () => {
	it("shows the policy's status while it works, then clears it", async () => {
		installDriver(pi.api, { policies: [alwaysInjects("gatey")] });
		await pi.emit({ type: "agent_settled" });

		const ours = pi.statuses.filter((s) => s.key === "agenda");
		expect(ours[0].text).toBe("working: gatey");
		expect(ours[ours.length - 1].text).toBe("");
	});
});

describe("/agenda command", () => {
	function makeRepo(config: Record<string, unknown>): string {
		const root = mkdtempSync(join(tmpdir(), "hive-pi-agenda-cmd-"));
		mkdirSync(join(root, ".git"), { recursive: true });
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify(config));
		return root;
	}

	it("is registered, along with the stop shortcut", () => {
		agenda(pi.api);
		expect(pi.commands.has("agenda")).toBe(true);
		expect(pi.shortcuts.has("ctrl+alt+.")).toBe(true);
	});

	it("reports an idle session distinctly from an armed one", () => {
		expect(describeAgenda({}, false, false)).toContain("nothing has re-entered the loop");
		expect(describeAgenda({ "gate:/repo": 2 }, false, false)).toContain("gate:/repo: 2");
	});

	it("says so when it is waiting on the user", () => {
		expect(describeAgenda({}, true, false)).toContain("Waiting on you");
		expect(describeAgenda({}, false, false)).not.toContain("Waiting on you");
	});

	it("reports itself inert inside a worker", () => {
		expect(describeAgenda({ "gate:/repo": 9 }, false, true)).toBe("agenda: inert (worker process).");
	});

	it("/agenda stop clears a charged budget", async () => {
		agenda(pi.api);
		const cwd = makeRepo({ check: "exit 1", checkTimeoutMs: 30_000, maxInjections: 3 });

		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(1);

		await pi.runCommand("agenda", "stop");
		await pi.emit({ type: "agent_settled" }, { cwd });

		// Budget was restored, so a second injection is allowed.
		expect(pi.messages).toHaveLength(2);
		expect(pi.messages[1].content).toContain("2 attempt(s) left");
	}, 15_000);

	it("rejects an unknown argument instead of silently showing status", async () => {
		agenda(pi.api);
		await pi.runCommand("agenda", "frobnicate");

		const last = pi.notifications[pi.notifications.length - 1];
		expect(last.type).toBe("warning");
		expect(last.message).toContain("frobnicate");
	});

	it("bare /agenda shows the status readout", async () => {
		agenda(pi.api);
		await pi.runCommand("agenda", "  ");

		const last = pi.notifications[pi.notifications.length - 1];
		expect(last.type).toBe("info");
		expect(last.message).toContain("nothing has re-entered the loop");
	});
});

describe("a turn that did not run is not evidence", () => {
	// Session 019fd3bc: a Ctrl+C mid-tool-call orphaned a `function_call_output`,
	// every later turn was refused by the provider, and because a refused turn
	// appends no evidence the goal evaluator kept truthfully saying "not met" —
	// so the driver kept injecting. Eight identical failures before the cap.
	it("does NOT run the chain after a provider error", async () => {
		const policy = alwaysInjects();
		installDriver(pi.api, { policies: [policy] });

		await pi.emit({ type: "agent_settled" }, { branch: assistantFailed("error", "Codex error: No tool call found for …") });

		expect(pi.messages).toHaveLength(0);
	});

	it("does NOT run the chain after the human aborted", async () => {
		// Stronger than wasteful: auto-continuing overrides an explicit stop.
		installDriver(pi.api, { policies: [alwaysInjects()] });

		await pi.emit({ type: "agent_settled" }, { branch: assistantFailed("aborted", "Operation aborted") });

		expect(pi.messages).toHaveLength(0);
	});

	it("charges the ledger nothing for a turn it never judged", async () => {
		const handle = installDriver(pi.api, { policies: [alwaysInjects()] });

		await pi.emit({ type: "agent_settled" }, { branch: assistantFailed("error") });

		expect(handle.ledger()).toEqual(emptyLedger);
	});

	it("stays armed — the NEXT real turn still injects", async () => {
		// A failure must suppress this settle, not disarm the goal for the session.
		installDriver(pi.api, { policies: [alwaysInjects()] });

		await pi.emit({ type: "agent_settled" }, { branch: assistantFailed("error") });
		expect(pi.messages).toHaveLength(0);

		await pi.emit({ type: "agent_settled" }, { branch: assistantSaid("here is the work") });
		expect(pi.messages).toHaveLength(1);
	});

	it("reports blockedOnUser for an abort, but not for a provider error", async () => {
		// An abort is a human decision `/agenda` should surface; a provider error
		// is not something the human did.
		const handle = installDriver(pi.api, { policies: [alwaysInjects()] });

		await pi.emit({ type: "agent_settled" }, { branch: assistantFailed("aborted") });
		expect(handle.blockedOnUser()).toBe(true);

		await pi.emit({ type: "agent_settled" }, { branch: assistantFailed("error") });
		expect(handle.blockedOnUser()).toBe(false);
	});
});
