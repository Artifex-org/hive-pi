/**
 * format-on-edit (HIV-3817): which formatter a repo declares, running it on
 * one file, and what the model is told.
 *
 * Detection is graded on an in-memory filesystem. Running is graded with
 * stand-in formatter scripts placed where the real ones live
 * (`node_modules/.bin`, `.venv/bin`), so the suite needs no formatter
 * installed and the extension finds them exactly as it would find the real
 * ones. One test runs the real hook through fake-pi.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { planFor, ruffSelectsIsort, type Plan, type Probe } from "../extensions/format-on-edit/detect.ts";
import { changedRegion, formatFile } from "../extensions/format-on-edit/run.ts";
import { createFakePi } from "./fake-pi.ts";

// ── Detection ────────────────────────────────────────────────────────────────

function memoryProbe(files: Record<string, string>, onPath: string[] = []): Probe {
	const dirs = new Set<string>();
	for (const path of Object.keys(files)) {
		let dir = dirname(path);
		while (!dirs.has(dir) && dir !== dirname(dir)) {
			dirs.add(dir);
			dir = dirname(dir);
		}
	}
	return {
		read: (path) => files[path] ?? null,
		exists: (path) => path in files || dirs.has(path),
		which: (name) => (onPath.includes(name) ? `/usr/bin/${name}` : null),
	};
}

const R = "/repo";
const git = { [`${R}/.git/HEAD`]: "ref: refs/heads/main\n" };

function steps(plan: Plan): string[] {
	return plan.kind === "format" ? plan.steps.map((step) => `${step.command} ${step.args.join(" ")} @${step.cwd}`) : [];
}

describe("planFor — never imposes a formatter", () => {
	it("formats nothing in a repo that declares nothing, even with binaries installed", () => {
		const probe = memoryProbe({ ...git, [`${R}/node_modules/.bin/prettier`]: "", [`${R}/.venv/bin/ruff`]: "", [`${R}/a.ts`]: "", [`${R}/a.py`]: "" });
		expect(planFor(`${R}/a.ts`, probe)).toEqual({ kind: "none" });
		expect(planFor(`${R}/a.py`, probe)).toEqual({ kind: "none" });
	});

	it("formats nothing outside a repository — a config in $HOME is not this repo's", () => {
		const probe = memoryProbe({ "/home/u/.prettierrc": "{}", "/home/u/node_modules/.bin/prettier": "", "/home/u/x/a.ts": "" });
		expect(planFor("/home/u/x/a.ts", probe)).toEqual({ kind: "none" });
	});
});

describe("planFor — Python", () => {
	const pyproject = '[tool.ruff]\nline-length = 100\n[tool.ruff.lint]\nselect = [\n  "E", "F",\n  "I",\n]\n';

	it("runs the repo's own ruff: import sort then format, when the config selects isort", () => {
		const probe = memoryProbe({ ...git, [`${R}/pyproject.toml`]: pyproject, [`${R}/.venv/bin/ruff`]: "", [`${R}/pkg/a.py`]: "" });
		expect(steps(planFor(`${R}/pkg/a.py`, probe))).toEqual([
			`${R}/.venv/bin/ruff check --fix --select I --exit-zero --force-exclude --quiet ${R}/pkg/a.py @${R}`,
			`${R}/.venv/bin/ruff format --force-exclude --quiet ${R}/pkg/a.py @${R}`,
		]);
	});

	it("does not sort imports for a repo that never chose isort", () => {
		const probe = memoryProbe({ ...git, [`${R}/ruff.toml`]: 'line-length = 88\n[lint]\nselect = ["E"]\n', [`${R}/.venv/bin/ruff`]: "", [`${R}/a.py`]: "" });
		expect(steps(planFor(`${R}/a.py`, probe))).toEqual([`${R}/.venv/bin/ruff format --force-exclude --quiet ${R}/a.py @${R}`]);
	});

	it("ignores a pyproject with no [tool.ruff] table", () => {
		const probe = memoryProbe({ ...git, [`${R}/pyproject.toml`]: "[tool.black]\n", [`${R}/.venv/bin/ruff`]: "", [`${R}/a.py`]: "" });
		expect(planFor(`${R}/a.py`, probe)).toEqual({ kind: "none" });
	});

	it("says ruff is configured but not installed, rather than using one from PATH", () => {
		const probe = memoryProbe({ ...git, [`${R}/pyproject.toml`]: pyproject, [`${R}/a.py`]: "" }, ["ruff"]);
		const plan = planFor(`${R}/a.py`, probe);
		expect(plan.kind).toBe("missing");
		expect(plan.kind === "missing" && plan.reason).toContain(".venv/bin/ruff");
	});

	it("recognises isort selection only in ruff's own select/extend-select", () => {
		expect(ruffSelectsIsort('[lint]\nextend-select = ["I"]\n', "ruff")).toBe(true);
		expect(ruffSelectsIsort('select = [\n  "E",\n  "I",\n]\n', "ruff")).toBe(true);
		expect(ruffSelectsIsort('[tool.ruff]\nselect = ["I"]\n', "pyproject")).toBe(true);
		expect(ruffSelectsIsort('[lint]\nselect = ["E", "F"]\nignore = ["I"]\n', "ruff")).toBe(false);
		// An isort SETTINGS table is not a selection.
		expect(ruffSelectsIsort('[tool.ruff.lint]\nselect = ["E"]\n[tool.ruff.lint.isort]\nknown-first-party = []\n', "pyproject")).toBe(false);
		// Another tool's select is not ruff's.
		expect(ruffSelectsIsort('[tool.ruff]\nline-length = 88\n[tool.flake8]\nselect = ["E", "I"]\n', "pyproject")).toBe(false);
	});

	it("leaves a black repo to black, even when it configures ruff's linter", () => {
		const probe = memoryProbe({
			...git,
			[`${R}/pyproject.toml`]: "[tool.ruff]\nline-length = 100\n[tool.black]\nline-length = 100\n",
			[`${R}/.venv/bin/ruff`]: "",
			[`${R}/a.py`]: "",
		});
		expect(planFor(`${R}/a.py`, probe)).toEqual({ kind: "none" });
	});
});

describe("planFor — Go", () => {
	it("uses gofmt in a Go module", () => {
		const probe = memoryProbe({ ...git, [`${R}/go.mod`]: "module x\n", [`${R}/cmd/main.go`]: "" }, ["gofmt", "goimports"]);
		expect(steps(planFor(`${R}/cmd/main.go`, probe))).toEqual([`/usr/bin/gofmt -w ${R}/cmd/main.go @${R}`]);
	});

	it("uses goimports only when the repo's golangci config names it", () => {
		const probe = memoryProbe(
			{ ...git, [`${R}/go.mod`]: "module x\n", [`${R}/.golangci.yml`]: "formatters:\n  enable:\n    - goimports\n", [`${R}/main.go`]: "" },
			["gofmt", "goimports"],
		);
		expect(steps(planFor(`${R}/main.go`, probe))).toEqual([`/usr/bin/goimports -w ${R}/main.go @${R}`]);
	});

	it("leaves vendored code and test fixtures alone, as Go's tooling does", () => {
		const probe = memoryProbe({ ...git, [`${R}/go.mod`]: "module x\n", [`${R}/vendor/x/a.go`]: "", [`${R}/pkg/testdata/b.go`]: "" }, ["gofmt"]);
		expect(planFor(`${R}/vendor/x/a.go`, probe)).toEqual({ kind: "none" });
		expect(planFor(`${R}/pkg/testdata/b.go`, probe)).toEqual({ kind: "none" });
	});

	it("formats no .go file outside a module", () => {
		expect(planFor(`${R}/main.go`, memoryProbe({ ...git, [`${R}/main.go`]: "" }, ["gofmt"]))).toEqual({ kind: "none" });
	});
});

describe("planFor — JavaScript/TypeScript", () => {
	it("runs oxfmt's OWN binary for an .oxfmtrc.json — never vite-plus's .bin/oxfmt wrapper, and not vp fmt", () => {
		// vp fmt never reads .oxfmtrc.json ("No config found, using defaults"),
		// and vite-plus's .bin/oxfmt refuses to format at all.
		const probe = memoryProbe({
			...git,
			[`${R}/.oxfmtrc.json`]: "{}",
			[`${R}/node_modules/.bin/vp`]: "",
			[`${R}/node_modules/.bin/oxfmt`]: "",
			[`${R}/node_modules/oxfmt/bin/oxfmt`]: "",
			[`${R}/frontend/web/vite.config.ts`]: 'import { defineConfig } from "vite-plus";\nexport default defineConfig({});\n',
			[`${R}/frontend/web/src/a.tsx`]: "",
		});
		expect(steps(planFor(`${R}/frontend/web/src/a.tsx`, probe))).toEqual([
			`${R}/node_modules/oxfmt/bin/oxfmt --no-error-on-unmatched-pattern ${R}/frontend/web/src/a.tsx @${R}`,
		]);
	});

	it("says an .oxfmtrc.json repo without the oxfmt package is not formatted, rather than running vp with defaults", () => {
		const probe = memoryProbe({ ...git, [`${R}/.oxfmtrc.json`]: "{}", [`${R}/node_modules/.bin/vp`]: "", [`${R}/a.ts`]: "" });
		expect(planFor(`${R}/a.ts`, probe)).toMatchObject({ kind: "missing", formatter: "oxfmt" });
	});

	it("runs `vp fmt` for a vite-plus `fmt` block, from that config's directory", () => {
		const probe = memoryProbe({
			...git,
			[`${R}/vite.config.ts`]: 'import { defineConfig } from "vite-plus";\nexport default defineConfig({ fmt: { semi: false } });\n',
			[`${R}/node_modules/.bin/vp`]: "",
			[`${R}/frontend/web/vite.config.ts`]: 'import { defineConfig } from "vite-plus";\nexport default defineConfig({});\n',
			[`${R}/frontend/web/src/a.tsx`]: "",
		});
		expect(steps(planFor(`${R}/frontend/web/src/a.tsx`, probe))).toEqual([
			`${R}/node_modules/.bin/vp fmt --no-error-on-unmatched-pattern ${R}/frontend/web/src/a.tsx @${R}`,
		]);
	});

	it("reads oxfmt's declaration from a vite-plus config's `fmt` block", () => {
		const probe = memoryProbe({
			...git,
			[`${R}/vite.config.ts`]: 'import { defineConfig } from "vite-plus";\nexport default defineConfig({ fmt });\n',
			[`${R}/node_modules/.bin/vp`]: "",
			[`${R}/a.ts`]: "",
		});
		expect(steps(planFor(`${R}/a.ts`, probe))[0]).toContain("vp fmt");
		const mentionOnly = memoryProbe({
			...git,
			[`${R}/vite.config.ts`]: '// we may adopt vite-plus fmt later\nimport { defineConfig } from "vite-plus";\nexport default defineConfig({ test: {} });\n',
			[`${R}/node_modules/.bin/vp`]: "",
			[`${R}/a.ts`]: "",
		});
		expect(planFor(`${R}/a.ts`, mentionOnly)).toEqual({ kind: "none" });
	});

	it("does not run oxfmt on a file type it does not format", () => {
		const probe = memoryProbe({ ...git, [`${R}/.oxfmtrc.json`]: "{}", [`${R}/node_modules/.bin/vp`]: "", [`${R}/a.md`]: "" });
		expect(planFor(`${R}/a.md`, probe)).toEqual({ kind: "none" });
	});

	it("runs prettier only with both a config and a local binary", () => {
		const configured = { ...git, [`${R}/.prettierrc`]: "{}", [`${R}/a.ts`]: "" };
		expect(planFor(`${R}/a.ts`, memoryProbe(configured)).kind).toBe("missing");
		const plan = planFor(`${R}/a.ts`, memoryProbe({ ...configured, [`${R}/node_modules/.bin/prettier`]: "" }));
		expect(steps(plan)).toEqual([`${R}/node_modules/.bin/prettier --write --ignore-unknown ${R}/a.ts @${R}`]);
	});

	it("runs prettier from the repo root, where .prettierignore lives, when a package's config wins", () => {
		const probe = memoryProbe({ ...git, [`${R}/pkg/.prettierrc`]: "{}", [`${R}/node_modules/.bin/prettier`]: "", [`${R}/pkg/a.ts`]: "" });
		expect(steps(planFor(`${R}/pkg/a.ts`, probe))[0]).toMatch(new RegExp(`@${R}$`));
	});

	it("does not run prettier on Markdown, YAML or JSON — a root .prettierrc is usually for the sources", () => {
		const probe = memoryProbe({ ...git, [`${R}/.prettierrc`]: "{}", [`${R}/node_modules/.bin/prettier`]: "", [`${R}/README.md`]: "", [`${R}/x.yaml`]: "" });
		expect(planFor(`${R}/README.md`, probe)).toEqual({ kind: "none" });
		expect(planFor(`${R}/x.yaml`, probe)).toEqual({ kind: "none" });
	});

	it("does not read prettier in devDependencies as a declaration", () => {
		const probe = memoryProbe({
			...git,
			[`${R}/package.json`]: '{ "devDependencies": { "prettier": "^3.4.2" } }',
			[`${R}/node_modules/.bin/prettier`]: "",
			[`${R}/a.ts`]: "",
		});
		expect(planFor(`${R}/a.ts`, probe)).toEqual({ kind: "none" });
	});

	it("reads a prettier key in package.json as a declaration", () => {
		const probe = memoryProbe({
			...git,
			[`${R}/package.json`]: '{ "name": "x", "prettier": { "semi": false } }',
			[`${R}/node_modules/.bin/prettier`]: "",
			[`${R}/a.ts`]: "",
		});
		expect(planFor(`${R}/a.ts`, probe)).toMatchObject({ kind: "format", formatter: "prettier" });
	});

	it("lets the NEAREST config win — a package that switched formatter is formatted its way", () => {
		const probe = memoryProbe({
			...git,
			[`${R}/.prettierrc`]: "{}",
			[`${R}/node_modules/.bin/prettier`]: "",
			[`${R}/pkg/biome.json`]: "{}",
			[`${R}/node_modules/.bin/biome`]: "",
			[`${R}/pkg/a.ts`]: "",
			[`${R}/b.ts`]: "",
		});
		expect(planFor(`${R}/pkg/a.ts`, probe)).toMatchObject({ formatter: "biome" });
		expect(planFor(`${R}/b.ts`, probe)).toMatchObject({ formatter: "prettier" });
	});

	it("prefers oxfmt over prettier when both are declared at the same level", () => {
		const probe = memoryProbe({
			...git,
			[`${R}/.oxfmtrc.json`]: "{}",
			[`${R}/.prettierrc`]: "{}",
			[`${R}/node_modules/.bin/vp`]: "",
			[`${R}/node_modules/.bin/prettier`]: "",
			[`${R}/a.ts`]: "",
		});
		expect(planFor(`${R}/a.ts`, probe)).toMatchObject({ formatter: "oxfmt" });
	});
});

// ── Running ──────────────────────────────────────────────────────────────────

describe("changedRegion", () => {
	it("is null when nothing changed", () => {
		expect(changedRegion("a\nb\n", "a\nb\n")).toBeNull();
	});

	it("names the changed lines of the new text", () => {
		expect(changedRegion("a\nb  =1\nc\n", "a\nb = 1\nc\n")).toEqual({ start: 2, end: 2, lines: ["b = 1"] });
	});

	it("covers a change that adds lines", () => {
		expect(changedRegion("f(a,b)\n", "f(\n  a,\n  b,\n)\n")).toEqual({ start: 1, end: 4, lines: ["f(", "  a,", "  b,", ")"] });
	});
});

function scratchRepo(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "format-on-edit-")));
	mkdirSync(join(dir, ".git"));
	return dir;
}

/** A stand-in formatter: a shell script at `path`. */
function script(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

/** A prettier stand-in that collapses runs of spaces — enough to change a file. */
const COLLAPSE_SPACES = 'for f in "$@"; do case "$f" in -*) ;; *) sed -i "s/  */ /g" "$f";; esac; done';

function formatPlan(command: string, cwd: string, file: string, label = "prettier --write"): Extract<Plan, { kind: "format" }> {
	return { kind: "format", formatter: "prettier", steps: [{ label, command, args: [file], cwd }] };
}

describe("formatFile", () => {
	it("says nothing when the file was already formatted", async () => {
		const dir = scratchRepo();
		script(join(dir, "fmt"), COLLAPSE_SPACES);
		writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
		expect(await formatFile(join(dir, "a.ts"), formatPlan(join(dir, "fmt"), dir, join(dir, "a.ts")))).toEqual({ note: null });
	});

	it("tells the model what changed, with the new text, so its next anchor is not stale", async () => {
		const dir = scratchRepo();
		script(join(dir, "fmt"), COLLAPSE_SPACES);
		writeFileSync(join(dir, "a.ts"), "const x = 1;\nconst   a   =   1;\nconst y = 2;\n");
		const { note } = await formatFile(join(dir, "a.ts"), formatPlan(join(dir, "fmt"), dir, join(dir, "a.ts")));
		expect(note).toContain("`prettier --write` reformatted this file: line 2 changed");
		expect(note).toContain("Anchor your next edit on the formatted text");
		expect(note).toContain("2  const a = 1;");
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const x = 1;\nconst a = 1;\nconst y = 2;\n");
	});

	it("reports a failing formatter with its message, and that the file is unformatted", async () => {
		const dir = scratchRepo();
		script(join(dir, "fmt"), 'echo "x Unexpected token at a.ts:1:7" >&2; exit 2');
		writeFileSync(join(dir, "a.ts"), "const = ;\n");
		const { note } = await formatFile(join(dir, "a.ts"), formatPlan(join(dir, "fmt"), dir, join(dir, "a.ts")));
		expect(note).toContain("`prettier --write` failed (exit 2)");
		expect(note).toContain("Unexpected token at a.ts:1:7");
		expect(note).toContain("not formatted");
	});

	it("kills a hung formatter's WHOLE tree, so nothing rewrites the file after the model is told", async () => {
		// A launcher whose child writes later — the `vp fmt` → oxfmt shape that
		// survived a kill aimed at the launcher alone.
		const dir = scratchRepo();
		script(join(dir, "fmt"), '( sleep 1; echo LATE >> "$1" ) &\nexec sleep 30');
		writeFileSync(join(dir, "a.ts"), "x\n");
		const started = Date.now();
		const { note } = await formatFile(join(dir, "a.ts"), formatPlan(join(dir, "fmt"), dir, join(dir, "a.ts")), 300);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(note).toContain("did not finish within");
		expect(note).toContain("not formatted");
		await new Promise((r) => setTimeout(r, 1_500));
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("x\n");
	});
});

// ── The hook, through pi's event path ────────────────────────────────────────

describe("the tool_result hook", () => {
	async function load(env: Record<string, string | undefined> = {}) {
		const saved = process.env.PI_FORMAT_ON_EDIT;
		if ("PI_FORMAT_ON_EDIT" in env) process.env.PI_FORMAT_ON_EDIT = env.PI_FORMAT_ON_EDIT;
		try {
			const extension = (await import("../extensions/format-on-edit/index.ts")).default;
			const pi = createFakePi();
			extension(pi.api as never);
			return pi;
		} finally {
			if (saved === undefined) delete process.env.PI_FORMAT_ON_EDIT;
			else process.env.PI_FORMAT_ON_EDIT = saved;
		}
	}

	function editResult(path: string, extra: Record<string, unknown> = {}) {
		return {
			type: "tool_result",
			toolName: "edit",
			toolCallId: "t1",
			input: { path },
			content: [{ type: "text", text: "Successfully replaced text in a.ts." }],
			isError: false,
			details: undefined,
			...extra,
		};
	}

	it("formats the edited file with the repo's prettier and appends the note to the result", async () => {
		const dir = scratchRepo();
		writeFileSync(join(dir, ".prettierrc"), "{}");
		script(join(dir, "node_modules", ".bin", "prettier"), COLLAPSE_SPACES);
		writeFileSync(join(dir, "a.ts"), "const   a = 1;\n");
		const pi = await load();
		const [result] = (await pi.emit(editResult("a.ts"), { cwd: dir })) as [{ content: { text: string }[] }];
		expect(result.content[0].text).toBe("Successfully replaced text in a.ts.");
		expect(result.content[1].text).toContain("[format-on-edit] `prettier --write` reformatted this file");
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const a = 1;\n");
	});

	it("leaves failed edits, other tools and undeclared repos alone", async () => {
		const dir = scratchRepo();
		writeFileSync(join(dir, "a.ts"), "const   a = 1;\n");
		const pi = await load();
		expect(await pi.emit(editResult("a.ts"), { cwd: dir })).toEqual([undefined]);
		writeFileSync(join(dir, ".prettierrc"), "{}");
		script(join(dir, "node_modules", ".bin", "prettier"), COLLAPSE_SPACES);
		expect(await pi.emit(editResult("a.ts", { isError: true }), { cwd: dir })).toEqual([undefined]);
		expect(await pi.emit(editResult("a.ts", { toolName: "read" }), { cwd: dir })).toEqual([undefined]);
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const   a = 1;\n");
	});

	it("says a configured-but-missing formatter once per session, not on every edit", async () => {
		const dir = scratchRepo();
		writeFileSync(join(dir, ".prettierrc"), "{}");
		writeFileSync(join(dir, "a.ts"), "x\n");
		const pi = await load();
		const [first] = (await pi.emit(editResult("a.ts"), { cwd: dir })) as [{ content: { text: string }[] }];
		expect(first.content[1].text).toContain("Not formatted: prettier is configured");
		expect(await pi.emit(editResult("a.ts"), { cwd: dir })).toEqual([undefined]);
	});

	it("registers nothing with PI_FORMAT_ON_EDIT=0", async () => {
		const pi = await load({ PI_FORMAT_ON_EDIT: "0" });
		expect(pi.handlers.get("tool_result") ?? []).toHaveLength(0);
	});
});
