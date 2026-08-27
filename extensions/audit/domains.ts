/**
 * Audit domains — WHAT an audit looks for, as data.
 *
 * The machinery of an audit does not change with its subject: scope it, model
 * the context, fan out one finder per theme, verify adversarially, filter the
 * false positives, report. Only the *content* changes. So the phases live once
 * in `prompts/audit.md` and each domain is a descriptor here.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THESE ARE DOMAINS, NOT MODES. The word "mode" is taken: it means the session
 * POSTURE the harness enforces (build/plan/discuss/bugfix — see
 * extensions/opmode/modes.ts), and a mode must be domain-free by that rule.
 * An audit domain is the opposite — it is nothing BUT domain content, which is
 * exactly why it is a skill parameter and not a posture. Keeping the two words
 * apart is the whole reason this comment exists.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * WHAT A DESCRIPTOR MAY NOT DO: grant tools. Tool lists live in role
 * frontmatter under `agents/`, which ships with this package and is pinned by
 * a test. A repo may extend a domain's themes or filters through its own
 * `.pi/audit.md`; it must never be able to hand a finder a shell, because the
 * finder reads code the repo itself controls.
 */

/** A domain's finder classes — one fan-out task each. */
export interface AuditTheme {
	key: string;
	/** What this finder hunts. Becomes the task's headline instruction. */
	looksFor: string;
}

export interface AuditDomain {
	key: string;
	label: string;
	/** One line: what this audit answers. Shown by `/audit` with no arguments. */
	question: string;
	/** Subagent role for the fan-out. MUST be a shell-free role — see below. */
	finderRole: string;
	/** Subagent role for adversarial verification. Navigation-only. */
	verifierRole: string;
	themes: AuditTheme[];
	/**
	 * The report's per-finding fields, in order. PER DOMAIN deliberately: an
	 * opportunity has no severity and no exploit scenario, and forcing
	 * security's shape onto it would produce a table of "severity: n/a".
	 */
	fields: string[];
	/** What the verifier is asked to establish. The lens differs per domain. */
	verifierLens: string;
	/** Discarded even when confirmed — the domain's known-noise list. */
	discards: string[];
	/**
	 * Facts the PARENT gathers (it has a shell) and passes into finder tasks as
	 * DATA. Finders never run these themselves — see the shell-free rule.
	 * Empty when the domain needs nothing beyond reading the repo.
	 */
	parentGathers: string[];
}

/**
 * WHY EVERY FINDER ROLE IS SHELL-FREE, in every domain.
 *
 * The security roles were built without a shell because they read untrusted
 * code, and a finder that can execute what it reads is the prompt-injection
 * vector the pipeline exists to close. That reasoning is not security-specific
 * — a dependency finder reads the same repo, and a compromised package.json is
 * a likelier injection carrier than most source files.
 *
 * So the property is universal here rather than a security exception, and
 * `test/audit-roles.test.ts` pins it across every finder. Where a domain
 * genuinely needs command output (a dependency tree, a lockfile diff), the
 * PARENT runs it and passes the result in as data: `parentGathers` above.
 *
 * The infra domain audits MANIFESTS IN THE REPO and nothing else. It does not
 * reach a live cluster, and no role here carries kubectl. Read-only cluster
 * access is still access — `kubectl get secrets` against a production trading
 * cluster is one fan-out task away from being someone's very bad afternoon —
 * and live-drift checking is a later increment, not a tool grant.
 */
export const AUDIT_DOMAINS: readonly AuditDomain[] = [
	{
		key: "security",
		label: "Security",
		question: "What here can an attacker abuse?",
		// Reused verbatim, not re-derived: these two roles are already pinned by
		// test/security-review-roles.test.ts and drive /security-review.
		finderRole: "security-finder",
		verifierRole: "security-verifier",
		themes: [
			{ key: "injection", looksFor: "SQL, command, template and path injection; unsafe deserialization" },
			{ key: "authz", looksFor: "missing or wrong authorization, IDOR, privilege boundaries, authentication gaps" },
			{ key: "secrets", looksFor: "credentials in code, weak defaults, exposed endpoints, unsafe config" },
			{ key: "supply-chain", looksFor: "unpinned or abandoned dependencies, install scripts, code fetched at build or run time" },
			{ key: "logic", looksFor: "state-machine flaws, TOCTOU, races, trust of client-supplied state" },
		],
		fields: ["severity", "confidence", "file:line", "class", "claim", "exploit_scenario", "recommendation"],
		verifierLens:
			"Is this exploitable as claimed? Attack the claim: find the guard the finder missed, the caller that sanitizes, " +
			"the framework default that already prevents it.",
		discards: [
			"DoS, rate limiting and resource exhaustion",
			"secrets on the developer's own disk",
			"generic input validation with no proven impact path",
			"open redirects",
		],
		parentGathers: [],
	},
	{
		key: "dependencies",
		label: "Dependency use",
		question: "Are we actually using what we install, and using it correctly?",
		finderRole: "dependency-finder",
		verifierRole: "audit-verifier",
		themes: [
			{ key: "unused", looksFor: "declared dependencies that nothing imports — dead weight in the install and the attack surface" },
			{ key: "undeclared", looksFor: "imports resolved from a transitive dependency rather than a declared one, which breaks the moment it is hoisted differently" },
			{ key: "duplicate", looksFor: "two or more dependencies doing the same job, or a dependency duplicating what the stdlib or an existing dep already provides" },
			{ key: "misuse", looksFor: "hand-rolled code the dependency already implements, deprecated APIs of a current dependency, and imports that pull far more than they use" },
			{ key: "version-risk", looksFor: "unpinned ranges, abandoned or EOL packages, and majors far behind with a known migration cost" },
		],
		fields: ["severity", "confidence", "package", "class", "claim", "evidence", "recommendation"],
		verifierLens:
			"Is the usage claim actually true? A dependency can be used through a re-export, a plugin registry, a config " +
			"string, or a build step, none of which look like an import. Refute anything you can reach another way.",
		discards: [
			"type-only and toolchain dependencies flagged as unused (they are used by the build, not the source)",
			"peer dependencies present to satisfy another package",
			"a pinned version being 'old' with no concrete risk named",
		],
		// The parent has a shell; the finders do not. It runs these and pastes
		// the output into each task.
		parentGathers: [
			"the dependency manifests and lockfile paths in scope",
			"`pnpm ls --depth 0` / `npm ls --depth 0` / `uv pip list` as the stack dictates",
			"`pnpm why <pkg>` for any package a finder later questions",
		],
	},
	{
		key: "infra",
		label: "Infrastructure",
		question: "Will what we have declared behave in production the way we think?",
		finderRole: "infra-finder",
		verifierRole: "audit-verifier",
		themes: [
			{ key: "correctness", looksFor: "manifests that do not do what they appear to: wrong selectors, missing resources or probes, images by mutable tag" },
			{ key: "posture", looksFor: "privileged or root containers, hostPath and hostNetwork, plaintext secrets, over-broad RBAC" },
			{ key: "reliability", looksFor: "single points of failure: one replica for a stateful path, no PodDisruptionBudget, no anti-affinity, no resource floor" },
			{ key: "drift", looksFor: "environments that have silently diverged — a value set in one overlay and not its sibling" },
			{ key: "waste", looksFor: "requests far above observed need, orphaned objects, jobs with no cleanup" },
		],
		fields: ["severity", "confidence", "file:line", "class", "claim", "impact_scenario", "recommendation"],
		verifierLens:
			"Would this actually bite? Check whether a kustomize overlay, an admission policy, a default or a sibling " +
			"manifest already supplies what the finder says is missing.",
		discards: [
			"missing limits where the namespace sets a LimitRange",
			"style preferences with no named failure mode",
			"anything requiring live-cluster state to establish — out of scope by design",
		],
		parentGathers: [
			"the manifest roots in scope (deploy/, k8s/, charts/, overlays)",
			"`kustomize build` output for each overlay, when kustomize is in use — the RENDERED manifests are what ships",
		],
	},
	{
		key: "opportunities",
		label: "Opportunities",
		question: "What should we build or fix next that nobody has written down?",
		finderRole: "opportunity-finder",
		verifierRole: "audit-verifier",
		themes: [
			{ key: "gaps", looksFor: "features the codebase is one step away from, and half-built paths nothing finishes" },
			{ key: "friction", looksFor: "rough edges a user or operator hits repeatedly — the workarounds visible in code comments, issues and retries" },
			{ key: "risk", looksFor: "load-bearing code with no test, and failure modes that would be silent in production" },
			{ key: "simplification", looksFor: "dead code, duplicated logic, and abstractions that cost more than they save" },
			{ key: "docs", looksFor: "knowledge that exists only in someone's head or in a commit message" },
		],
		// No severity, no exploit: an opportunity is value-and-effort, and
		// borrowing security's shape here produces a column of "n/a".
		fields: ["value", "effort", "area", "claim", "rationale", "existing_ticket"],
		verifierLens:
			"Is this worth doing and NOT already tracked? Search Linear before judging. Refute anything already ticketed, " +
			"already done, or whose value cannot be stated without hedging.",
		discards: [
			"restatements of a TODO comment with nothing added",
			"speculative rewrites with no named benefit",
			"anything already covered by an open ticket (say which)",
		],
		parentGathers: ["the repo's Linear team key, so the verifier can search for existing tickets"],
	},
];

/** Depth levels. Orthogonal to the domain: how hard, not what for. */
export type AuditDepth = "lite" | "balanced" | "deep";

export const AUDIT_DEPTHS: readonly AuditDepth[] = ["lite", "balanced", "deep"];

export const DEFAULT_AUDIT_DEPTH: AuditDepth = "balanced";

/** What each depth actually changes — decision-complete, so the prompt need not improvise. */
export const AUDIT_DEPTH_PLAN: Record<AuditDepth, string> = {
	lite:
		"Scope and context model, then ONE combined pass over all themes. No fan-out, no adversarial verification. " +
		"Report findings as candidates and say plainly that they are unverified.",
	balanced:
		"Scope and context model, one finder per theme in parallel, adversarial verification of every finding above the " +
		"confidence floor, then the domain filter. The default.",
	deep:
		"Balanced, then repeat finder rounds until two consecutive rounds surface nothing new, with state persisted so the " +
		"audit can resume. Security only: build proofs-of-concept for confirmed HIGH findings inside the state directory, " +
		"and delete them in a final cleanup phase.",
};

export function findDomain(key: string): AuditDomain | undefined {
	return AUDIT_DOMAINS.find((domain) => domain.key === key);
}

export function isAuditDepth(value: unknown): value is AuditDepth {
	return typeof value === "string" && (AUDIT_DEPTHS as readonly string[]).includes(value);
}
