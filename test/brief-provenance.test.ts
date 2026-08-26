/**
 * brief — the git-measured history section (HIV-1806).
 *
 * Driven against a REAL repository rather than a mocked `execFile`, because
 * every interesting behaviour here is a property of git's own output: what
 * `ls-files` returns for an ambiguous basename, what `log` prints for a path
 * that exists untracked, what happens outside a repo at all. A mock would
 * encode this file's beliefs about git and then agree with them.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidatePaths, collectProvenance, parseLogLine } from "../extensions/brief/provenance.ts";
import { gitAvailable } from "./require-tools.ts";

const FIELD_SEP = "\x1f";

describe("candidatePaths", () => {
	it("finds path-shaped tokens and strips a line suffix", () => {
		expect(candidatePaths("fix extensions/brief/run.ts:88 and ./config.ts")).toEqual(["extensions/brief/run.ts", "config.ts"]);
	});

	it("ignores prose that merely contains a dot", () => {
		expect(candidatePaths("the pass takes 4.5 seconds, i.e. too long")).toEqual([]);
	});

	it("deduplicates a path named twice", () => {
		expect(candidatePaths("run.ts is slow — see run.ts:12")).toEqual(["run.ts"]);
	});
});

describe("parseLogLine", () => {
	it("reads hash, date and subject", () => {
		expect(parseLogLine(["a1b2c3d", "2026-08-13", "feat(brief): fan out the pass"].join(FIELD_SEP))).toBe(
			"last changed 2026-08-13 in a1b2c3d — feat(brief): fan out the pass",
		);
	});

	// A subject may contain anything a human types, including the characters an
	// obvious separator would have used. If a subject ever split itself, half a
	// commit message would land in the date field of the one section whose whole
	// claim is that it was measured.
	it("keeps a subject containing pipes and tabs intact", () => {
		const subject = "fix: pipe | and\ttab in one subject";
		expect(parseLogLine(["a1b2c3d", "2026-08-13", subject].join(FIELD_SEP))).toContain(subject);
	});

	it("returns null for anything that is not three fields", () => {
		expect(parseLogLine("just some text")).toBeNull();
		expect(parseLogLine(["a1b2c3d", "2026-08-13", ""].join(FIELD_SEP))).toBeNull();
	});
});

describe.runIf(gitAvailable())("collectProvenance", () => {
	let repo: string;

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "hive-pi-brief-prov-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");

		mkdirSync(join(repo, "extensions", "brief"), { recursive: true });
		mkdirSync(join(repo, "extensions", "advisor"), { recursive: true });
		writeFileSync(join(repo, "extensions", "brief", "run.ts"), "export const lanes = 3;\n");
		writeFileSync(join(repo, "extensions", "brief", "index.ts"), "export default 1;\n");
		writeFileSync(join(repo, "extensions", "advisor", "index.ts"), "export default 2;\n");
		git("add", "-A");
		git("commit", "-q", "-m", "feat(brief): fan the retrieval pass out across lanes");
	});

	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	it("reports the last commit to touch a named file", async () => {
		const facts = await collectProvenance({ task: "the fan-out in extensions/brief/run.ts is too slow", cwd: repo });
		expect(facts).toHaveLength(1);
		expect(facts[0]?.ref).toBe("extensions/brief/run.ts");
		expect(facts[0]?.note).toContain("feat(brief): fan the retrieval pass out across lanes");
	});

	it("resolves a bare filename that is unambiguous", async () => {
		const facts = await collectProvenance({ task: "why is run.ts blocking the first turn", cwd: repo });
		expect(facts[0]?.ref).toBe("extensions/brief/run.ts");
	});

	/**
	 * An ambiguous basename returns NOTHING, on purpose. `index.ts` names two
	 * files here and a dozen in the real repo; reporting the most recently
	 * committed one of them as "the" file the task meant would be a confident
	 * wrong answer inside the section whose entire value is being checkable.
	 */
	it("declines an ambiguous basename rather than guessing", async () => {
		const facts = await collectProvenance({ task: "index.ts needs a look", cwd: repo });
		expect(facts).toEqual([]);
	});

	it("resolves an ambiguous basename once the task gives it a directory", async () => {
		const facts = await collectProvenance({ task: "look at brief/index.ts", cwd: repo });
		expect(facts[0]?.ref).toBe("extensions/brief/index.ts");
	});

	it("returns nothing for an untracked file rather than failing", async () => {
		writeFileSync(join(repo, "scratch.ts"), "// not committed\n");
		expect(await collectProvenance({ task: "check scratch.ts", cwd: repo })).toEqual([]);
	});

	it("honours its cap", async () => {
		const facts = await collectProvenance({
			task: "compare extensions/brief/run.ts with extensions/brief/index.ts",
			cwd: repo,
			max: 1,
		});
		expect(facts).toHaveLength(1);
	});

	// This runs on the path that gates every session's first turn, so "not a
	// repo" has to be an empty section, never an exception.
	it("is silent outside a git repository", async () => {
		const plain = mkdtempSync(join(tmpdir(), "hive-pi-brief-nogit-"));
		try {
			expect(await collectProvenance({ task: "look at run.ts", cwd: plain })).toEqual([]);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("costs nothing when the task names no paths", async () => {
		expect(await collectProvenance({ task: "make the scheduler testable", cwd: repo })).toEqual([]);
	});
});
