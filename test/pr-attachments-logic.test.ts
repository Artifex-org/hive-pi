import { describe, expect, it } from "vitest";
import type { ScreenshotRecord } from "../extensions/pr-attachments/manifest.ts";
import {
	MIN_ATTACH_VERSION,
	UI_GLOBS,
	attachArg,
	beforeNudge,
	commandShapeKey,
	ghAttachlessSegment,
	isUIVisiblePath,
	parseGhVersion,
	prNudge,
	splitCommands,
	versionAtLeast,
} from "../extensions/pr-attachments/logic.ts";

describe("isUIVisiblePath — every glob is enumerated (HIV-3240)", () => {
	// Positive: one path per documented glob, plus worktree-prefixed forms.
	it.each([
		"web/App.tsx",
		"web/styles/main.css",
		"frontend/index.js",
		"mobile/screens/Home.jsx",
		"apps/dashboard/page.tsx",
		"src/components/Button.tsx",
		"lib/widget.jsx",
		"src/App.vue",
		"src/App.svelte",
		"styles/theme.css",
		"styles/theme.scss",
		"app/templates/emails/welcome.html",
		"src/Button.stories.tsx",
		"src/Button.stories.jsx",
		"/home/joan/repos/x__worktrees/feat/web/App.tsx",
	])("treats %s as UI-visible", (p) => {
		expect(isUIVisiblePath(p)).toBe(true);
	});

	// Negative: non-UI files a too-broad rule would sweep in.
	it.each([
		"server/db.ts",
		"README.md",
		"package.json",
		"scripts/build.sh",
		"docs/notes.html", // a plain .html not under templates/
		"extensions/pr-attachments/logic.ts",
		"src/util.test.ts",
		undefined,
	])("does not treat %s as UI-visible", (p) => {
		expect(isUIVisiblePath(p as string | undefined)).toBe(false);
	});

	it("exposes exactly the documented globs", () => {
		expect(UI_GLOBS).toContain("**/*.tsx");
		expect(UI_GLOBS).toContain("**/templates/**/*.html");
		expect(UI_GLOBS).toContain("web/**");
	});
});

describe("splitCommands", () => {
	it("splits on &&, ||, ; and | at top level", () => {
		expect(splitCommands("a && b || c ; d | e")).toEqual(["a ", " b ", " c ", " d ", " e"]);
	});

	it("does not split inside quotes or $( )", () => {
		expect(splitCommands('gh pr create --body "a && b"')).toEqual(['gh pr create --body "a && b"']);
		expect(splitCommands("gh pr create --body \"$(echo a && echo b)\"")).toEqual([
			'gh pr create --body "$(echo a && echo b)"',
		]);
	});
});

describe("ghAttachlessSegment — the PR-nudge matcher", () => {
	it("matches gh pr create / edit / comment without --attach", () => {
		expect(ghAttachlessSegment("gh pr create --title x --body-file b.md")).toContain("gh pr create");
		expect(ghAttachlessSegment("gh pr edit 12 --body-file b.md")).toContain("gh pr edit");
		expect(ghAttachlessSegment("gh pr comment 3 --body-file b.md")).toContain("gh pr comment");
	});

	it("matches gh issue create / edit / comment", () => {
		expect(ghAttachlessSegment("gh issue create --title x")).toContain("gh issue create");
		expect(ghAttachlessSegment("gh issue comment 5 --body-file b.md")).toContain("gh issue comment");
	});

	it("returns null when --attach is already present", () => {
		expect(ghAttachlessSegment("gh pr create --attach 'a.png#before'")).toBeNull();
		expect(ghAttachlessSegment("gh pr create --title x --attach=a.png#b")).toBeNull();
	});

	it("tolerates --repo / --hostname global flags before the subcommand", () => {
		expect(ghAttachlessSegment("gh --repo o/r pr create --body-file b.md")).toContain("gh --repo o/r pr create");
	});

	it("finds the gh segment inside a compound && command", () => {
		const cmd = "git add -A && git commit -m x && gh pr create --body-file b.md";
		expect(ghAttachlessSegment(cmd)).toBe("gh pr create --body-file b.md");
	});

	it("finds an attachless gh segment even when an earlier segment has --attach in prose", () => {
		const cmd = "echo 'use --attach' && gh pr create --body-file b.md";
		expect(ghAttachlessSegment(cmd)).toBe("gh pr create --body-file b.md");
	});

	it("returns null for non-gh and non-PR commands", () => {
		expect(ghAttachlessSegment("gh repo view")).toBeNull();
		expect(ghAttachlessSegment("git push")).toBeNull();
		expect(ghAttachlessSegment(undefined)).toBeNull();
		expect(ghAttachlessSegment("gh pr list")).toBeNull();
	});
});

describe("commandShapeKey — once per shape, not per retry", () => {
	it("collapses retries of the same command to one key", () => {
		const a = commandShapeKey("gh pr create --title x --body-file b.md");
		const b = commandShapeKey("gh pr create --title y --body-file other.md");
		expect(a).toBe(b);
		expect(a).toBe("gh pr create");
	});

	it("distinguishes create from a numbered comment", () => {
		expect(commandShapeKey("gh pr create --body-file b.md")).toBe("gh pr create");
		expect(commandShapeKey("gh pr comment 5 --body-file b.md")).toBe("gh pr comment 5");
		expect(commandShapeKey("gh issue edit 9 --body-file b.md")).toBe("gh issue edit 9");
	});
});

describe("parseGhVersion / versionAtLeast — the gate", () => {
	it("parses the normal first line", () => {
		expect(parseGhVersion("gh version 2.99.0 (2026-08-21)\nhttps://…")).toEqual({ major: 2, minor: 99, patch: 0 });
	});

	it("parses through a mise shim banner prepended to the output", () => {
		expect(parseGhVersion("mise activated\ngh version 2.101.3 (2026-10-01)")).toEqual({ major: 2, minor: 101, patch: 3 });
	});

	it("returns null when no version is present", () => {
		expect(parseGhVersion("command not found")).toBeNull();
		expect(parseGhVersion(undefined)).toBeNull();
	});

	it("gates at 2.99.0", () => {
		expect(MIN_ATTACH_VERSION).toEqual({ major: 2, minor: 99, patch: 0 });
		expect(versionAtLeast({ major: 2, minor: 99, patch: 0 })).toBe(true);
		expect(versionAtLeast({ major: 2, minor: 99, patch: 5 })).toBe(true);
		expect(versionAtLeast({ major: 3, minor: 0, patch: 0 })).toBe(true);
		expect(versionAtLeast({ major: 2, minor: 98, patch: 0 })).toBe(false); // this node's pin
		expect(versionAtLeast({ major: 2, minor: 100, patch: 0 })).toBe(true);
		expect(versionAtLeast(null)).toBe(false);
	});
});

describe("the nudge text", () => {
	const recs: ScreenshotRecord[] = [
		{ path: "/tmp/pi-browser-1/shot-1.png", label: "before", url: "http://127.0.0.1:3000/", taken_at: "t1" },
		{ path: "/tmp/pi-browser-1/shot-2.png", label: "after", url: "http://127.0.0.1:3000/", taken_at: "t2" },
	];

	it("before nudge says take `before` now and cannot be taken later", () => {
		const n = beforeNudge();
		expect(n).toContain("before");
		expect(n).toMatch(/cannot be captured|before the edit lands/i);
	});

	it("attachArg is single-quoted and strips backticks from the label", () => {
		const arg = attachArg({ path: "/a/shot.png", label: "the `Save` button", url: "u", taken_at: "t" });
		expect(arg).toBe("--attach '/a/shot.png#the 'Save' button: <what this shows>'");
		expect(arg).not.toContain("`");
	});

	it("PR nudge (gh new enough) lists each --attach and suggests --body-file", () => {
		const n = prNudge(recs, { tooOld: false, version: { major: 2, minor: 99, patch: 0 } });
		expect(n).toContain("--attach '/tmp/pi-browser-1/shot-1.png#before");
		expect(n).toContain("--attach '/tmp/pi-browser-1/shot-2.png#after");
		expect(n).toContain("--body-file");
		expect(n).toContain("shot-1.png (before)");
	});

	it("PR nudge (gh too old) says post without images and list paths", () => {
		const n = prNudge(recs, { tooOld: true, version: { major: 2, minor: 98, patch: 0 } });
		expect(n).toContain("2.98.0");
		expect(n).toMatch(/without images/i);
		expect(n).toContain("shot-1.png");
		expect(n).not.toContain("--attach '");
	});
});
