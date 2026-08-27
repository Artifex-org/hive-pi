/**
 * The craft-ui skill prescribes a script. It has to be one the reader can run.
 *
 * `audit-hardcoded-colors.sh` ships INSIDE the skill, and the skill named it as
 * `scripts/audit-hardcoded-colors.sh` — a path relative to the skill directory.
 * The reader is an agent whose shell cwd is the TARGET REPO, so bash resolved it
 * there and answered
 *
 *	sh: scripts/audit-hardcoded-colors.sh: No such file or directory
 *
 * in every repo that does not happen to vendor a script of that name — which is
 * all of them. Three agents hit it in hive (2026-08-16, 08-17, 08-19) and
 * shipped UI work with step 7 unvalidated.
 *
 * The sibling `references/*.md` paths are fine unfixed: those are READ, and the
 * harness resolves a skill's own files. Only the one that gets EXECUTED crosses
 * into a different cwd, which is why this is about scripts and not about links.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "craft-ui");
const SCRIPT_REL = "scripts/audit-hardcoded-colors.sh";

describe("craft-ui audit script", () => {
	it("ships with the skill", () => {
		expect(existsSync(join(SKILL_DIR, SCRIPT_REL))).toBe(true);
	});

	// The exact broken form: a command that STARTS with the bare relative path.
	// Prose mentioning `scripts/…` is fine — the fix's own text quotes it to say
	// not to use it — so this looks for it in command position.
	for (const file of ["SKILL.md", "references/process.md"]) {
		it(`${file} does not tell the reader to run a bare repo-relative path`, () => {
			const text = readFileSync(join(SKILL_DIR, file), "utf8");
			const runsBarePath = /(?:^|[\n`])\s*(?:Run\s+)?`?\.?\/?scripts\/audit-hardcoded-colors\.sh[^`]*`/i.test(
				text.replace(/A bare `scripts\/audit-hardcoded-colors\.sh` is (?:equally )?wrong/g, ""),
			);
			// Not an exact-string ban: the point is that no INSTRUCTION resolves
			// against the target repo. Prose that names the wrong form in order to
			// warn about it is the opposite of the defect.
			const warns = /bare `scripts\/audit-hardcoded-colors\.sh` is (?:equally )?wrong|NOT a bare/i.test(text);
			expect(runsBarePath && !warns).toBe(false);
		});
	}

	it("SKILL.md names where the script actually lives", () => {
		const text = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
		// A reader who does not already know the skill's own directory needs to be
		// told it — that is the whole repair.
		expect(text).toMatch(/skills\/craft-ui/);
		expect(text).toMatch(/ships with this skill/i);
	});
});
