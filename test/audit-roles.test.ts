/**
 * The audit pipeline's security PROPERTIES live in role frontmatter and in the
 * domain registry, not in code — so they get pinned here.
 *
 * The load-bearing one is the shell rule. Finders read code the audited
 * repository controls, so a finder that can execute what it reads is the
 * prompt-injection vector the whole pipeline exists to close. That was
 * originally a security-review property (HIV-1225); this file makes it
 * UNIVERSAL, because a dependency finder reads package.json and an infra finder
 * reads manifests — both at least as good a carrier for adversarial text as
 * source code.
 *
 * The second one is quieter and worse if it slips: no audit role may hold
 * cluster or write credentials. A fan-out of subagents with kubectl is a
 * fan-out with production access, and "read-only" cluster access still reads
 * secrets.
 *
 * test/security-review-roles.test.ts stays as it is and keeps its own pins —
 * these are additional, not a replacement.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { discoverAgents } from "../extensions/harness/roles.ts";
import { AUDIT_DEPTHS, AUDIT_DEPTH_PLAN, AUDIT_DOMAINS, DEFAULT_AUDIT_DEPTH, findDomain } from "../extensions/audit/domains.ts";

beforeAll(() => {
	// Same isolation as the sibling role tests: on a developer machine
	// ~/.pi/agent/agents symlinks to these files and would re-label every role.
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "hive-pi-auditroles-"));
});

const shipped = () => discoverAgents(process.cwd(), "user").agents;
const role = (name: string) => shipped().find((agent) => agent.name === name);

/** Every finder named by any domain, plus the security one the registry reuses. */
const FINDERS = ["security-finder", "dependency-finder", "infra-finder", "opportunity-finder"];
const VERIFIERS = ["security-verifier", "audit-verifier"];

describe("audit roles ship", () => {
	it("ships every role the domain registry names", () => {
		const names = shipped().map((agent) => agent.name);
		for (const domain of AUDIT_DOMAINS) {
			expect(names, `domain ${domain.key} names finder ${domain.finderRole}`).toContain(domain.finderRole);
			expect(names, `domain ${domain.key} names verifier ${domain.verifierRole}`).toContain(domain.verifierRole);
		}
	});
});

describe("no finder gets a shell — in any domain", () => {
	it("every finder has an explicit tool list without shell or write tools", () => {
		for (const name of FINDERS) {
			const agent = role(name);
			expect(agent, name).toBeDefined();
			const tools = agent?.tools ?? [];
			expect(tools.length, `${name} must have an explicit tool list`).toBeGreaterThan(0);
			for (const banned of ["bash", "write", "edit", "multiedit", "apply_patch"]) {
				expect(tools, `${name} must not carry ${banned} — it reads code the repo controls`).not.toContain(banned);
			}
		}
	});

	// The one that would be easiest to add "just for the infra audit", and the
	// one with production blast radius.
	it("no audit role carries cluster or infrastructure credentials", () => {
		for (const name of [...FINDERS, ...VERIFIERS]) {
			const tools = role(name)?.tools ?? [];
			for (const tool of tools) {
				expect(
					tool.startsWith("mcp__kubernetes__") || tool === "kubectl",
					`${name} must not carry ${tool}: read-only cluster access still reads production secrets`,
				).toBe(false);
			}
		}
	});
});

describe("verifiers stay narrow", () => {
	// Unchanged from the security pipeline's own pin, restated because the audit
	// registry now depends on it too.
	it("the security verifier is navigation-only", () => {
		expect(role("security-verifier")?.tools ?? []).toEqual(["read", "grep", "find", "ls"]);
	});

	// The audit verifier used to grant `mcp__linear__list_issues` and
	// `mcp__linear__get_issue`, so that "is this already tracked" — half of
	// verifying an opportunity — could be answered.
	//
	// Those names never resolved. A per-tool `mcp__<server>__<tool>` name exists
	// only when a server is configured with `directTools`, and none is, so the
	// grant was dead in the parent session as well as in a worker (HIV-1581).
	// This assertion previously pinned the dead names as if they worked.
	//
	// The gateway tool `mcp` would restore the access and is deliberately NOT
	// granted: it reaches every Linear tool, `save_issue` and `save_comment`
	// included. The safety property this test was written to protect is exactly
	// that, so it is now asserted as a property rather than as a list — a
	// verifier must have no path to writing the tracker, and `mcp` is a path.
	it("the audit verifier has no path to writing Linear", () => {
		const tools = role("audit-verifier")?.tools ?? [];
		expect(tools).toEqual(["read", "grep", "find", "ls"]);
		for (const path of ["mcp", "mcpScript", "mcp__linear__save_issue", "mcp__linear__save_comment", "bash"]) {
			expect(tools, `an adversarial verifier must not be able to reach Linear writes via ${path}`).not.toContain(path);
		}
	});

	it("says in its body that it cannot check Linear, rather than implying it can", () => {
		// The role's job is to refute, so an unanswerable question must come back
		// as UNVERIFIABLE. A body that still instructs a Linear lookup would have
		// the model either hallucinate the answer or silently drop the check.
		const body = role("audit-verifier")?.systemPrompt ?? "";
		expect(body).toContain("UNVERIFIABLE");
		expect(body).toMatch(/cannot query Linear/i);
	});
});

describe("the domain registry is coherent", () => {
	it("covers the four domains the audit offers", () => {
		expect(AUDIT_DOMAINS.map((d) => d.key)).toEqual(["security", "dependencies", "infra", "opportunities"]);
	});

	it("gives every domain themes, report fields, a lens and a discard list", () => {
		for (const domain of AUDIT_DOMAINS) {
			expect(domain.themes.length, `${domain.key} needs themes to fan out over`).toBeGreaterThan(0);
			expect(domain.fields.length, `${domain.key} needs report fields`).toBeGreaterThan(0);
			expect(domain.verifierLens.length, `${domain.key} needs a verifier lens`).toBeGreaterThan(0);
			expect(domain.discards.length, `${domain.key} needs a discard list`).toBeGreaterThan(0);
			const themeKeys = domain.themes.map((t) => t.key);
			expect(new Set(themeKeys).size, `${domain.key} has duplicate theme keys`).toBe(themeKeys.length);
			for (const theme of domain.themes) {
				expect(theme.looksFor.length, `${domain.key}/${theme.key} needs a description`).toBeGreaterThan(0);
			}
		}
	});

	// The report shape is per-domain on purpose: an opportunity has no severity
	// and no exploit scenario, and borrowing security's fields would produce a
	// column of "n/a".
	it("does not force security's report shape onto every domain", () => {
		expect(findDomain("security")?.fields).toContain("exploit_scenario");
		const opportunities = findDomain("opportunities");
		expect(opportunities?.fields).toContain("value");
		expect(opportunities?.fields).not.toContain("severity");
		expect(opportunities?.fields).not.toContain("exploit_scenario");
	});

	it("reuses the security pipeline's existing roles rather than forking them", () => {
		const security = findDomain("security");
		expect(security?.finderRole).toBe("security-finder");
		expect(security?.verifierRole).toBe("security-verifier");
	});

	// The infra domain's whole safety argument is that it reads the repo.
	it("keeps infra on repo manifests, with no live-cluster gathering", () => {
		const infra = findDomain("infra");
		for (const gather of infra?.parentGathers ?? []) {
			expect(gather.toLowerCase(), "infra must not gather live-cluster state").not.toContain("kubectl");
		}
	});

	it("explains every depth and defaults to one of them", () => {
		for (const depth of AUDIT_DEPTHS) {
			expect(AUDIT_DEPTH_PLAN[depth]?.length, `${depth} needs a plan`).toBeGreaterThan(0);
		}
		expect(AUDIT_DEPTHS).toContain(DEFAULT_AUDIT_DEPTH);
	});
});
