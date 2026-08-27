/**
 * The house profile — the one place an ORGANISATION's own facts enter this
 * harness.
 *
 * This repository is the public foundation. Everything in it has to work for
 * somebody whose repos, MCP servers and knowledge collections we have never
 * heard of, and several extensions nonetheless need to answer questions that
 * only a specific organisation can answer:
 *
 *   - which knowledge collections belong to the checkout I am in?
 *   - which configured MCP servers are a PRODUCT of this checkout, rather than
 *     useful everywhere?
 *   - which repository names, appearing in a prompt, suggest cross-repo work?
 *   - which MCP tools has somebody actually reviewed as read-only?
 *
 * Before the public/private split those answers were literals in four different
 * modules. That is what this file replaces: ONE optional JSON file, read once,
 * consumed by every site that used to hardcode.
 *
 *   ~/.pi/agent/house-profile.json      (override with PI_HOUSE_PROFILE)
 *
 * ## Why a separate file and not a settings.json key
 *
 * pi writes settings.json itself — a theme change or a changelog bump rewrites
 * it. A key we have not proven survives that round-trip would disappear
 * silently, and every consumer here fails SOFT: the capability would simply
 * stop happening, on a machine where it had worked, with no error anywhere.
 * A file with exactly one writer cannot fail that way.
 *
 * ## The empty default is a real, deliberate behaviour
 *
 * No profile is the ordinary case — a fresh machine, a public checkout, anyone
 * who is not us. Every consumer degrades to the conservative answer rather than
 * to a guess:
 *
 *   - collectionsFor()   -> the default collections only (no project routing)
 *   - productMcpOwner()  -> nothing is a product server, so every configured
 *                           server is reported in every checkout
 *   - repoNamePattern()  -> null, so the "names two repos" complexity signal
 *                           never fires and the heuristic leans on its others
 *   - readOnlyMcpTools() -> empty, so no MCP card is pre-approved for plan mode
 *
 * None of those is a broken state. Each is the answer you would want from a
 * harness that has not been told anything about your organisation.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One project this organisation works in, and what belongs to it. */
export interface HouseProject {
	/**
	 * The lowercase token that identifies the project in a checkout PATH.
	 * `aurora` matches `~/repos/Aurora__worktrees/feature`. Substring, not exact:
	 * worktree layouts decorate the name and every consumer here was already
	 * matching that way.
	 */
	token: string;
	/** Knowledge collections searched for work in this project's checkout. */
	knowledgeCollections?: string[];
	/**
	 * MCP servers that are this project's PRODUCT — configured globally so any
	 * session can reach them, but only a capability of this project's checkout.
	 */
	mcpServers?: string[];
	/**
	 * How a stdio launcher for this project's MCP server is named on disk, when
	 * it is staged rather than built. Used only to say something useful in a
	 * readiness hint.
	 */
	mcpLauncher?: string;
}

export interface HouseProfile {
	projects?: HouseProject[];
	/**
	 * Collections searched in EVERY checkout, including one no project claims.
	 * Ours is the personal `knowledge-base`: infrastructure and workstation
	 * notes are relevant to work anywhere.
	 */
	defaultKnowledgeCollections?: string[];
	/** Repository names worth recognising in a prompt. Plain names, no regex. */
	repoNames?: string[];
	/**
	 * Issue-tracker team keys, e.g. `["HIV", "ACME"]`. Used to spot a ticket
	 * reference in a prompt. Empty means no key is recognised — a conservative
	 * default: the ticket lane simply does not fire, and the caller falls back to
	 * the prompt's other evidence.
	 */
	ticketKeys?: string[];
	/**
	 * MCP tools reviewed as read-only, by exact `server_tool` name. Exact names
	 * rather than a server prefix on purpose: this list is an assertion that
	 * somebody read the implementation, and a prefix would extend that claim to
	 * every tool the server grows later.
	 */
	readOnlyMcpTools?: string[];
	/**
	 * What the welcome header calls this install. Defaults to `pi`.
	 *
	 * Here rather than hardcoded because it is the one string in this package
	 * that is purely somebody's own: it used to be a personal name, which is
	 * correct on one machine and wrong on every other. Personalisation belongs
	 * with the rest of an organisation's facts, not in shared code.
	 */
	headerTitle?: string;
}

const EMPTY: HouseProfile = {};

let cached: HouseProfile | null = null;

export function profilePath(home = homedir()): string {
	const override = process.env.PI_HOUSE_PROFILE?.trim();
	if (override) return override;
	return join(home, ".pi", "agent", "house-profile.json");
}

/**
 * The profile, or an empty one.
 *
 * A malformed file reads as ABSENT rather than throwing. This is called from
 * extension init paths, and a JSON typo in an optional config file must not be
 * able to stop a session from starting.
 */
export function houseProfile(): HouseProfile {
	if (cached) return cached;
	try {
		const parsed: unknown = JSON.parse(readFileSync(profilePath(), "utf8"));
		cached = parsed && typeof parsed === "object" ? (parsed as HouseProfile) : EMPTY;
	} catch {
		cached = EMPTY;
	}
	return cached;
}

/** Test seam. Never called in production. */
export function setHouseProfileForTest(profile: HouseProfile | null): void {
	cached = profile;
}

/** The project whose token appears in this path, if any. */
export function projectFor(cwd: string, profile = houseProfile()): HouseProject | null {
	const path = cwd.toLowerCase();
	for (const project of profile.projects ?? []) {
		const token = project.token?.toLowerCase();
		if (token && path.includes(token)) return project;
	}
	return null;
}

/**
 * Knowledge collections for work in this checkout.
 *
 * An unmapped checkout gets the defaults alone rather than "everything the
 * credential can see": a repo nobody has classified is far more likely to be
 * helped by general notes than by another product's documentation.
 */
export function collectionsFor(cwd: string, profile = houseProfile()): string[] {
	const defaults = profile.defaultKnowledgeCollections ?? [];
	const project = projectFor(cwd, profile);
	if (!project?.knowledgeCollections?.length) return [...defaults];
	return [...new Set([...project.knowledgeCollections, ...defaults])];
}

/** The project token owning this MCP server, or null when it belongs everywhere. */
export function productMcpOwner(server: string, profile = houseProfile()): string | null {
	for (const project of profile.projects ?? []) {
		if (project.mcpServers?.includes(server)) return project.token;
	}
	return null;
}

/** False only for a product MCP whose project is not this checkout. */
export function mcpBelongsHere(server: string, cwd: string, profile = houseProfile()): boolean {
	const owner = productMcpOwner(server, profile);
	if (!owner) return true;
	return projectFor(cwd, profile)?.token === owner;
}

/** The staged-launcher name for a product server, for a readiness hint. */
export function mcpLauncherFor(server: string, profile = houseProfile()): string | null {
	for (const project of profile.projects ?? []) {
		if (project.mcpServers?.includes(server)) return project.mcpLauncher ?? null;
	}
	return null;
}

/** Every configured launcher name, so a path can be recognised as one. */
export function mcpLaunchers(profile = houseProfile()): string[] {
	return (profile.projects ?? []).map((p) => p.mcpLauncher).filter((l): l is string => !!l);
}

/**
 * A pattern matching this organisation's repository names, or null when none
 * are configured — in which case the caller's signal simply does not fire.
 */
export function repoNamePattern(profile = houseProfile()): RegExp | null {
	const names = (profile.repoNames ?? []).filter((n) => n && /^[\w.-]+$/.test(n));
	if (names.length === 0) return null;
	return new RegExp(`\\b(${names.join("|")})\\b`, "gi");
}

/**
 * A pattern matching this organisation's ticket keys (`HIV-1234`), or null when
 * none are configured.
 *
 * These were a literal `/\b(?:TES|ASF|HIV)-\d+\b/` in the public code — three
 * team keys of three private trackers, which both leaks an inventory and is
 * useless to anybody else.
 */
export function ticketKeyPattern(profile = houseProfile()): RegExp | null {
	const keys = (profile.ticketKeys ?? []).filter((k) => /^[A-Z][A-Z0-9]{1,9}$/.test(k));
	if (keys.length === 0) return null;
	return new RegExp(`\\b(?:${keys.join("|")})-\\d+\\b`, "g");
}

/** What the welcome header calls this install. `pi` when nobody has said. */
export function headerTitle(profile = houseProfile()): string {
	const t = profile.headerTitle?.trim();
	return t && t.length > 0 ? t : "pi";
}

/** MCP tools somebody has reviewed as read-only. Empty by default. */
export function readOnlyMcpTools(profile = houseProfile()): ReadonlySet<string> {
	return new Set(profile.readOnlyMcpTools ?? []);
}
