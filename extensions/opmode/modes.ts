/**
 * Operating modes — the session POSTURE axis.
 *
 * NOT the model axis. hive-remote's `set_mode` already picks WHICH MODEL
 * thinks; this picks WHAT THE HARNESS ALLOWS while it thinks. The two were
 * colliding under one word in the Hive agents workspace, where a dropdown
 * labelled "mode" set the model and nothing at all set the posture.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE RULE THAT DECIDES WHAT MAY JOIN THIS LIST — read it before adding one.
 *
 * A MODE is a domain-free, mutually exclusive, sticky posture the harness
 * ENFORCES: it changes what the agent is ALLOWED to do on every subsequent
 * turn. A SKILL is a domain procedure: what work to do, invoked per task,
 * composable with any mode.
 *
 * Two prongs, and a candidate must pass BOTH:
 *
 *   1. It has an enforcement delta — tool gating, write access, a verification
 *      gate. If it can be fully expressed as prompt text, it is a skill.
 *   2. It carries no domain content. A security-audit checklist, a
 *      Linear/Sentry triage workflow, a release runbook — those are work TYPES
 *      that run perfectly well inside `build`, and they already exist as skills.
 *
 * "Security audit mode" and "triage mode" fail both prongs. They are the
 * requests this comment exists to answer.
 *
 * HARDCODED — this is a `const` array, not config, and that is deliberate.
 * A mode's SEMANTICS live in the enforcement code below it, so a config list of
 * postures would let someone add one with nothing enforcing it: configured,
 * green, and enforcing nothing, which is the exact failure plan/policy.ts's
 * header documents. Adding a mode should require writing the enforcement down.
 *
 * Growth pressure drains into skills by construction: modes are mutually
 * exclusive, so they cap out at a handful, while skills compose without bound.
 * ───────────────────────────────────────────────────────────────────────────
 */

export type OpMode = "build" | "plan" | "discuss" | "bugfix" | "orchestrate";

export const OP_MODES: readonly OpMode[] = ["build", "plan", "discuss", "bugfix", "orchestrate"];

export const DEFAULT_OP_MODE: OpMode = "build";

export function isOpMode(value: unknown): value is OpMode {
	return typeof value === "string" && (OP_MODES as readonly string[]).includes(value);
}

/** One-line descriptions, shown by `/mode` and in the Hive tooltip. */
export const OP_MODE_ENFORCES: Record<OpMode, string> = {
	build: "Nothing — the default. Full tool access.",
	plan: "Writes and mutating shell commands denied; produces a plan to approve.",
	discuss: "Read-only, and no plan or tasks are produced — answer and stop.",
	bugfix: "File edits denied until a root cause is recorded; investigation tools stay open.",
	orchestrate: "Implementation denied; only team coordination, Factory dispatch, communication, and verification are allowed.",
};

/**
 * The file-mutation tools `bugfix` withholds until a root cause exists.
 *
 * DELIBERATELY NARROWER THAN PLAN MODE'S GATE, and this is the design decision
 * most likely to look like an oversight, so: bugfix must NOT reuse
 * plan/policy.ts's fail-closed classifier. That gate denies bash, and bugfix's
 * whole purpose is the investigation — building inspection and measurement
 * tools, running the repro, instrumenting, re-running the failing test. A mode
 * that blocked all of that in the name of "find the root cause first" would
 * make finding the root cause impossible.
 *
 * So bash stays open, which means the gate is fail-OPEN: `sh -c 'echo x > f'`
 * walks straight through it. That is accepted rather than overlooked. Plan
 * mode's gate is fail-closed because its promise is "nothing happens" — a
 * safety property. Bugfix's promise is a working discipline: no fix before a
 * root cause. A discipline is enforced well enough by making the wrong path
 * require deliberate circumvention; it does not need, and cannot afford, a
 * boundary that also blocks the work.
 */
export const BUGFIX_WITHHELD_TOOLS = new Set(["edit", "write", "multiedit", "notebook_edit", "apply_patch"]);
