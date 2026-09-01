import { describe, expect, it } from "vitest";
import { doubleQuotedBodies, ghBodyVerdict, hasLiveBacktick } from "../extensions/guards-common/gh-body-guard.ts";

// The blocked cases are the papercuts verbatim (2026-08-17/18); the allowed
// cases are the working idioms a too-broad rule would have taken with them.

describe("ghBodyVerdict blocks", () => {
	it("the observed `gh pr create` with a markdown code span in a double-quoted body", () => {
		const v = ghBodyVerdict('gh pr create --title "x" --body "Adds `PromptEditor` and wires it up"');
		expect(v.kind).toBe("block");
		if (v.kind === "block") expect(v.reason).toContain("--body-file");
	});

	it("the same shape with the short flag, and with `=`", () => {
		expect(ghBodyVerdict('gh pr create -b "renames `max_image_file_bytes`"').kind).toBe("block");
		expect(ghBodyVerdict('gh issue comment 4 --body="see `lib/selection`"').kind).toBe("block");
	});

	it("a body whose backticks sit outside a command substitution it also contains", () => {
		expect(
			ghBodyVerdict('gh pr create --body "$(cat /tmp/head.md) then `de-DE` fallback"').kind,
		).toBe("block");
	});

	it("gh reached through a pipeline or after another command", () => {
		expect(ghBodyVerdict('git push -u origin b && gh pr create --body "adds `x`"').kind).toBe("block");
	});

	it("serialized Markdown inline in PR create or edit", () => {
		const body = `## Summary\\n- preserve separate list items\\n\\n## Verification\\n- tests passed`;
		for (const command of [
			`gh pr create --body '${body}'`,
			`gh pr create -b='${body}'`,
			`gh pr edit 42 --body="${body}"`,
			`gh pr edit 42 --repo Artifex-org/hive -b '${body}'`,
			`gh --hostname github.example pr create --body '${body}'`,
		]) {
			const v = ghBodyVerdict(command);
			expect(v.kind, command).toBe("block");
			if (v.kind === "block") expect(v.reason).toContain("literal \\n separators");
		}
	});
});

describe("ghBodyVerdict allows", () => {
	it("a single-quoted body — no expansion happens", () => {
		expect(ghBodyVerdict("gh pr create --body 'adds `PromptEditor`'").kind).toBe("allow");
	});

	it("forms that are not serialized Markdown", () => {
		const serialized = `## Summary\\n- a list item\\n\\n## Verification\\n- test`;
		const json = JSON.stringify({ summary: serialized });
		for (const command of [
			'gh pr create --body-file "/tmp/pr-body.md"',
			'gh pr create --body "## Summary\r\n- formatted\r\n\r\n## Verification\r\n- pass"',
			`gh pr create --body '${json}'`,
			'gh pr create --body \'Call printf("first\\ntwo\\nthree")\'',
			'gh pr create --body \'## Literal\\\\nnot a Markdown line break\\\\n## Still literal\'',
			'gh pr create --body \'- literal list one\\n- literal list two\\n- literal list three\'',
			'gh pr create --body "## Summary\n- physical\\n- literal\n\n## Verification\n- pass"',
			`gh issue comment 42 --body '${serialized}'`,
		]) {
			expect(ghBodyVerdict(command).kind).toBe("allow");
		}
	});

	it("--body-file, which is the remediation and must never match --body", () => {
		expect(ghBodyVerdict('gh pr create --body-file "/tmp/pr `weird` name.md"').kind).toBe("allow");
	});

	it("a substitution the author clearly meant, including a quoted heredoc", () => {
		expect(ghBodyVerdict('gh pr create --body "$(cat /tmp/body.md)"').kind).toBe("allow");
		expect(
			ghBodyVerdict("gh pr create --body \"$(cat <<'EOF'\nuses `code` spans\nEOF\n)\"").kind,
		).toBe("allow");
	});

	it("a backtick that is already escaped", () => {
		expect(ghBodyVerdict('gh pr create --body "a literal \\` backtick"').kind).toBe("allow");
	});

	it("a body with no backticks at all", () => {
		expect(ghBodyVerdict('gh pr create --body "plain prose, nothing to expand"').kind).toBe("allow");
	});

	it("a --body that is not gh's", () => {
		expect(ghBodyVerdict('curl -d --body "has `backticks`" https://example.com').kind).toBe("allow");
	});

	it("an empty or absent command", () => {
		expect(ghBodyVerdict(undefined).kind).toBe("allow");
		expect(ghBodyVerdict("").kind).toBe("allow");
	});
});

describe("doubleQuotedBodies", () => {
	it("returns each body value, stopping at the unescaped closing quote", () => {
		expect(doubleQuotedBodies('gh pr create --body "one" --notes "two"')).toEqual(["one", "two"]);
	});

	it("keeps an escaped quote inside the value rather than ending on it", () => {
		expect(doubleQuotedBodies('gh pr create --body "say \\"hi\\" now"')).toEqual(['say \\"hi\\" now']);
	});
});

describe("hasLiveBacktick", () => {
	it("ignores backticks inside a command substitution", () => {
		expect(hasLiveBacktick("$(echo `date`)")).toBe(false);
		expect(hasLiveBacktick("$(echo x) `date`")).toBe(true);
	});
});

// The first real encounter with this guard (2026-08-18, 25 minutes after it
// shipped) was a `git commit && git push && gh pr create --body "…"` chain. The
// refusal was right — a guard cannot run two thirds of a command — but the
// message spoke only about the PR body, so the agent read it as a body problem
// and lost the commit and push with it.
describe("a compound command", () => {
	it("says the whole chain was refused, and what to re-run", () => {
		const v = ghBodyVerdict('git commit -m x && git push && gh pr create --body "adds `x`"');
		expect(v.kind).toBe("block");
		if (v.kind !== "block") return;
		expect(v.reason).toContain("WHOLE command");
		expect(v.reason).toContain("Nothing in it ran");
	});

	it("does not add the note to a single command, where there is no chain to lose", () => {
		const v = ghBodyVerdict('gh pr create --body "adds `x`"');
		expect(v.kind).toBe("block");
		if (v.kind !== "block") return;
		expect(v.reason).not.toContain("WHOLE command");
	});
});
