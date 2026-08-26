/**
 * The audit extension actually LOADS and its tools actually answer.
 *
 * Typechecking proves none of this: an extension that throws on registration,
 * or a tool that returns nothing, compiles perfectly and fails only when
 * someone runs `/audit` for real.
 *
 * The path-handling tests are the ones with teeth. `slug` and `name` reach
 * these tools from the model and are used to build a filesystem path, so
 * traversal is a live concern rather than a theoretical one — and the state
 * directory holds quoted source and, at deep, proofs-of-concept.
 */

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import auditExtension from "../extensions/audit/index.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

let workdir: string;
let cwd: string;

beforeAll(() => {
	// The state tools write under process.cwd(); point that at a temp dir so a
	// test run never creates .pi/audit/ in the repo.
	workdir = mkdtempSync(join(tmpdir(), "hive-pi-audit-"));
	cwd = process.cwd();
	process.chdir(workdir);
});

afterAll(() => {
	process.chdir(cwd);
});

function boot(): FakePi {
	const pi = createFakePi();
	auditExtension(pi.api);
	return pi;
}

/**
 * Run a registered tool and return its text output.
 *
 * `execute` hangs off `.definition`, not off the recorded tool itself — the
 * fake records `{name, definition}`. Reading it from the wrong level returns
 * undefined and every assertion then compares against an empty string, which
 * looks like nine broken tools rather than one broken helper.
 */
async function call(pi: FakePi, name: string, params: Record<string, unknown>): Promise<string> {
	const tool = pi.tools.find((t) => t.name === name);
	if (!tool) throw new Error(`no tool registered named "${name}"`);
	const execute = (tool.definition as { execute?: (...args: unknown[]) => Promise<unknown> }).execute;
	if (!execute) throw new Error(`tool "${name}" has no execute`);
	const result = (await execute("id", params, undefined, undefined, undefined)) as
		| { content?: { text?: string }[] }
		| undefined;
	return result?.content?.[0]?.text ?? "";
}

describe("the extension loads", () => {
	it("registers its tools and NO slash command", () => {
		const pi = boot();
		const names = pi.tools.map((t) => t.name).sort();
		expect(names).toEqual(["audit_depth", "audit_domains", "audit_state_read", "audit_state_write"]);
		// `/audit` is prompts/audit.md. Registering a command of the same name
		// here would collide with it — and an extension command cannot start the
		// agent working the way a prompt does.
		expect(pi.commands.has("audit")).toBe(false);
	});
});

describe("audit_domains answers", () => {
	it("lists every domain when given none", async () => {
		const out = await call(boot(), "audit_domains", {});
		for (const key of ["security", "dependencies", "infra", "opportunities"]) {
			expect(out).toContain(key);
		}
		expect(out).toContain("balanced");
	});

	it("describes one domain with its themes, fields and lens", async () => {
		const out = await call(boot(), "audit_domains", { domain: "dependencies" });
		expect(out).toContain("unused");
		expect(out).toContain("dependency-finder");
		expect(out).toContain("NO shell");
		expect(out).toContain("evidence");
	});

	it("names the available set on an unknown domain rather than guessing", async () => {
		const out = await call(boot(), "audit_domains", { domain: "compliance" });
		expect(out).toContain("Unknown audit domain");
		expect(out).toContain("security");
	});
});

describe("audit_depth answers", () => {
	it("falls back to the default and explains it", async () => {
		expect(await call(boot(), "audit_depth", {})).toContain("balanced");
	});

	it("refuses an unknown depth with the set", async () => {
		const out = await call(boot(), "audit_depth", { depth: "paranoid" });
		expect(out).toContain("Unknown depth");
		expect(out).toContain("lite");
	});
});

describe("audit state is written safely", () => {
	it("round-trips a note and git-ignores the whole audit tree", async () => {
		const pi = boot();
		await call(pi, "audit_state_write", { slug: "security-2026-08-07", name: "scope.md", content: "# Scope\n42 files" });

		const read = await call(pi, "audit_state_read", { slug: "security-2026-08-07", name: "scope.md" });
		expect(read).toContain("42 files");

		const listed = await call(pi, "audit_state_read", { slug: "security-2026-08-07" });
		expect(listed).toContain("scope.md");

		// The state holds quoted source and, at deep, proofs-of-concept. A
		// `git add -A` must not be able to sweep it into a PR.
		const ignore = join(workdir, ".pi", "audit", ".gitignore");
		expect(existsSync(ignore)).toBe(true);
		expect(readFileSync(ignore, "utf8")).toContain("*");
	});

	it("refuses a slug or name that would escape the audit directory", async () => {
		const pi = boot();
		for (const slug of ["../../etc", "a/b", ".ssh", "", "UPPER/../x"]) {
			const out = await call(pi, "audit_state_write", { slug, name: "x.md", content: "x" });
			expect(out, `slug ${JSON.stringify(slug)} must be refused`).toContain("slug must be");
		}
		for (const name of ["../escape.md", "a/b.md", ".gitignore"]) {
			const out = await call(pi, "audit_state_write", { slug: "ok", name, content: "x" });
			expect(out, `name ${JSON.stringify(name)} must be refused`).toContain("plain file name");
		}
	});

	it("refuses an empty note rather than creating a misleading empty file", async () => {
		const out = await call(boot(), "audit_state_write", { slug: "ok", name: "empty.md", content: "   " });
		expect(out).toContain("empty note");
	});

	it("says so plainly when an audit has recorded nothing", async () => {
		const out = await call(boot(), "audit_state_read", { slug: "never-run" });
		expect(out).toContain("recorded nothing yet");
	});
});
