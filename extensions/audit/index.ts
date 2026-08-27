/**
 * audit — the shared machinery behind `/audit <domain>`.
 *
 * DELIBERATELY TOOL-ONLY. It registers no slash command, because `/audit` is
 * `prompts/audit.md`: a prompt file is what actually starts the agent working
 * with `$ARGUMENTS` substituted, where an extension command handler would have
 * to fake that by injecting a turn. Registering `audit` here as well would also
 * collide with the prompt. So the phases live in the prompt, as text, and this
 * supplies the two things text is bad at:
 *
 *   1. `audit_domains` — the closed domain set as DATA, so the model reads the
 *      themes, fields, filters and verifier lens rather than re-deriving them
 *      from prose and drifting a little on every run.
 *   2. `audit_state_*` — durable notes for a `deep` audit, which spans more
 *      turns (and often more sessions) than a context window survives.
 *
 * There is deliberately no orchestration engine here. The `subagent` extension
 * already is one, and a second scheduler that only this feature used would be a
 * second thing to keep correct.
 *
 * The four mechanical constraints from plan/index.ts apply: no `context`
 * handler, nothing mutable at module scope, `setActiveTools` is advisory, and
 * nothing here injects a turn.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AUDIT_DEPTHS,
	AUDIT_DEPTH_PLAN,
	AUDIT_DOMAINS,
	DEFAULT_AUDIT_DEPTH,
	findDomain,
	isAuditDepth,
} from "./domains.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";

/**
 * Where a deep audit keeps its notes.
 *
 * Inside the audited repo (not `~/.pi`) because the state is ABOUT this repo
 * and an operator should be able to read it, diff it, and delete it without
 * hunting through a home directory. Under `.pi/` to match the
 * `.pi/security-review.md` override the security pipeline already reads.
 *
 * NOT committed: `ensureStateDir` writes a `.gitignore` containing `*` on
 * creation, so a half-finished audit — which quotes source, findings and
 * sometimes a proof-of-concept — cannot ride a `git add -A` into a PR.
 */
function stateRoot(slug: string): string {
	return join(process.cwd(), ".pi", "audit", slug);
}

/** Slugs address a directory, so they are constrained rather than trusted. */
function cleanSlug(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const slug = raw.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) return null;
	// Defence in depth against `..` surviving the pattern above: the resolved
	// path must still sit under the audit root.
	const root = resolve(join(process.cwd(), ".pi", "audit"));
	if (!resolve(stateRoot(slug)).startsWith(root + "/")) return null;
	return slug;
}

function ensureStateDir(slug: string): string {
	const dir = stateRoot(slug);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const ignore = join(process.cwd(), ".pi", "audit", ".gitignore");
	// Written once at the audit root rather than per-slug: one file covers every
	// audit, and rewriting it per call would fight a deliberate edit.
	if (!existsSync(ignore)) {
		writeFileSync(ignore, "# Audit working state — findings, quoted source, PoCs. Never committed.\n*\n", { mode: 0o600 });
	}
	return dir;
}

function text(body: string) {
	return { content: [{ type: "text" as const, text: body }], details: {} };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "audit_domains",
		label: "Audit domains",
		description:
			"The closed set of audit domains and depth levels, with each domain's themes, report fields, verifier lens " +
			"and discard list. Call this FIRST in an audit: it is the authoritative definition, and reciting a domain " +
			"from memory instead is how two runs of the same audit come to mean different things.",
		promptSnippet: "Audit: read the domain definition with audit_domains before planning phases.",
		parameters: Type.Object({
			domain: Type.Optional(
				Type.String({ description: "One domain key. Omit to list every domain with its question." }),
			),
		}),
		execute: async (_id, params) => {
			const key = (params as { domain?: string }).domain?.trim();
			if (!key) {
				const lines = AUDIT_DOMAINS.map((d) => `  ${d.key.padEnd(14)} ${d.label} — ${d.question}`);
				const depths = AUDIT_DEPTHS.map((d) => `  ${d.padEnd(9)} ${AUDIT_DEPTH_PLAN[d]}`);
				return text(
					`Audit domains (closed set):\n${lines.join("\n")}\n\nDepths (default: ${DEFAULT_AUDIT_DEPTH}):\n${depths.join("\n")}`,
				);
			}
			const domain = findDomain(key);
			if (!domain) {
				// Name the set rather than only refusing: the caller is working from
				// a prompt built on this same list, so a miss means they are out of
				// step and being told how is the fastest way to see it.
				return text(
					`Unknown audit domain "${key}". Available: ${AUDIT_DOMAINS.map((d) => d.key).join(", ")}.`,
				);
			}
			const themes = domain.themes.map((t) => `  ${t.key.padEnd(15)} ${t.looksFor}`).join("\n");
			const gathers = domain.parentGathers.length
				? domain.parentGathers.map((g) => `  - ${g}`).join("\n")
				: "  (nothing — reading the repo is enough)";
			return text(
				[
					`# ${domain.label} audit — ${domain.question}`,
					``,
					`finder role:   ${domain.finderRole}   (read-only, NO shell — it reads code the repo controls)`,
					`verifier role: ${domain.verifierRole}`,
					``,
					`## Themes (one parallel finder each)`,
					themes,
					``,
					`## Report fields, in order`,
					`  ${domain.fields.join(" · ")}`,
					``,
					`## Verifier lens`,
					`  ${domain.verifierLens}`,
					``,
					`## Discard even when confirmed`,
					domain.discards.map((d) => `  - ${d}`).join("\n"),
					``,
					`## The PARENT gathers these and passes them in as data`,
					gathers,
				].join("\n"),
			);
		},
	});

	registerGuardedTool(pi, {
		// The one migration here that CHANGES behaviour: audit notes were written
		// into `<cwd>/.pi/audit/` even inside a guarded worktree, because the tool
		// had its own path containment (a slug regex) and never consulted the
		// worktree guard. It now refuses there, like every other write.
		capability: {
			writesResolved: (params, cwd) => {
				const slug = typeof params.slug === "string" ? params.slug : "";
				const name = typeof params.name === "string" ? params.name : "";
				if (!slug || !name) return [];
				return [`${(cwd ?? ".").replace(/\/+$/, "")}/.pi/audit/${slug}/${name}`];
			},
		},
		name: "audit_state_write",
		label: "Audit state write",
		description:
			"Persist a note for a deep audit — the scope, a round's findings, a verdict, the resume point. Written under " +
			".pi/audit/<slug>/ in the audited repo and git-ignored. Use it so a deep audit survives compaction and can " +
			"resume in a later session.",
		parameters: Type.Object({
			slug: Type.String({ description: "Audit id, e.g. `security-2026-08-07`. Lowercase, no slashes." }),
			name: Type.String({ description: "File name within the audit, e.g. `scope.md` or `round-2-findings.md`." }),
			content: Type.String({ description: "The note, as markdown." }),
		}),
		execute: async (_id, params) => {
			const { slug: rawSlug, name: rawName, content } = params as { slug?: string; name?: string; content?: string };
			const slug = cleanSlug(rawSlug);
			if (!slug) return text("A slug must be lowercase letters, digits, dot, dash or underscore — no slashes.");
			const name = typeof rawName === "string" ? rawName.trim() : "";
			if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name)) {
				return text("A note name must be a plain file name — no slashes, no leading dot.");
			}
			if (typeof content !== "string" || content.trim() === "") return text("Refusing to write an empty note.");
			const dir = ensureStateDir(slug);
			writeFileSync(join(dir, name), content, { mode: 0o600 });
			return text(`Wrote .pi/audit/${slug}/${name} (${content.length} bytes).`);
		},
	});

	pi.registerTool({
		name: "audit_state_read",
		label: "Audit state read",
		description:
			"Read back a deep audit's notes. With no `name`, lists what the audit has recorded so far — the first call " +
			"to make when resuming one.",
		parameters: Type.Object({
			slug: Type.String({ description: "Audit id." }),
			name: Type.Optional(Type.String({ description: "One note. Omit to list all of them." })),
		}),
		execute: async (_id, params) => {
			const { slug: rawSlug, name } = params as { slug?: string; name?: string };
			const slug = cleanSlug(rawSlug);
			if (!slug) return text("A slug must be lowercase letters, digits, dot, dash or underscore — no slashes.");
			const dir = stateRoot(slug);
			if (!existsSync(dir)) return text(`No audit state at .pi/audit/${slug}/ — this audit has recorded nothing yet.`);
			if (!name) {
				const files = readdirSync(dir).sort();
				return text(files.length ? `.pi/audit/${slug}/:\n${files.map((f) => `  ${f}`).join("\n")}` : `.pi/audit/${slug}/ is empty.`);
			}
			const path = join(dir, name);
			// Re-resolve rather than trust the joined path: `name` reaches here
			// from the model, and a read is still a read of whatever it names.
			if (!resolve(path).startsWith(resolve(dir) + "/") || !existsSync(path)) {
				return text(`No such note: ${name}`);
			}
			return text(readFileSync(path, "utf8"));
		},
	});

	// Depth is validated where it is used rather than guessed at: a caller that
	// mistypes `--deep` as a depth gets the set back instead of a silent default.
	pi.registerTool({
		name: "audit_depth",
		label: "Audit depth",
		description: "Resolve and explain an audit depth (lite | balanced | deep). Returns the default when given nothing.",
		parameters: Type.Object({
			depth: Type.Optional(Type.String({ description: "Requested depth. Omit for the default." })),
		}),
		execute: async (_id, params) => {
			const raw = (params as { depth?: string }).depth?.trim();
			if (!raw) return text(`${DEFAULT_AUDIT_DEPTH} (default) — ${AUDIT_DEPTH_PLAN[DEFAULT_AUDIT_DEPTH]}`);
			if (!isAuditDepth(raw)) return text(`Unknown depth "${raw}". Available: ${AUDIT_DEPTHS.join(", ")}.`);
			return text(`${raw} — ${AUDIT_DEPTH_PLAN[raw]}`);
		},
	});
}
