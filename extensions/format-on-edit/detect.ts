/**
 * Which formatter does THIS repo declare for THIS file?
 *
 * Pure apart from reading the filesystem through `Probe`, so the rules are
 * graded on fixtures. The rule that matters most: **never impose a formatter.**
 * A repo that configures none gets none, and a repo that configures one gets
 * exactly that one, run from its own install — a different formatter, or the
 * same one at another version, rewrites lines the repo's pre-commit hook will
 * then rewrite back, and the agent is left with a diff it did not make.
 *
 * So every plan here needs two facts from the repo: a CONFIG that declares the
 * formatter, and a PROJECT-LOCAL binary (`node_modules/.bin`, `.venv/bin`).
 * Go is the one exception, and it is not really one: gofmt ships with the Go
 * toolchain that builds the module, so `go.mod` is the declaration and the
 * toolchain's own gofmt is the install.
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";

/** The filesystem questions detection asks — injectable for tests. */
export interface Probe {
	/** File contents, or null when absent/unreadable. */
	read(path: string): string | null;
	/** Whether a path exists (file or directory). */
	exists(path: string): boolean;
	/** An executable on PATH, or null. */
	which(name: string): string | null;
}

export interface Step {
	/** Shown to the model, e.g. `ruff format`. */
	label: string;
	command: string;
	args: string[];
	cwd: string;
}

export type Plan =
	| { kind: "format"; formatter: string; steps: Step[] }
	/** Configured, but nothing project-local to run it with. Said once, not skipped silently. */
	| { kind: "missing"; formatter: string; key: string; reason: string }
	| { kind: "none" };

const JS_FAMILY = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const BIOME_EXTRA = [".json", ".jsonc", ".css"];

const PRETTIER_CONFIGS = [
	".prettierrc",
	".prettierrc.json",
	".prettierrc.json5",
	".prettierrc.yaml",
	".prettierrc.yml",
	".prettierrc.toml",
	".prettierrc.js",
	".prettierrc.cjs",
	".prettierrc.mjs",
	".prettierrc.ts",
	".prettierrc.cts",
	".prettierrc.mts",
	"prettier.config.js",
	"prettier.config.cjs",
	"prettier.config.mjs",
	"prettier.config.ts",
	"prettier.config.cts",
	"prettier.config.mts",
];
const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];

/**
 * The repository root: the nearest ancestor holding `.git` (a directory in a
 * clone, a file in a worktree). Config and binaries are only searched up to
 * here — a `.prettierrc` in someone's home directory is not this repo's
 * declaration. No root means no formatting at all.
 */
export function repoRootOf(file: string, probe: Probe): string | null {
	let dir = dirname(file);
	for (;;) {
		if (probe.exists(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Directories from the file's own up to the root, nearest first. */
function ancestry(file: string, root: string): string[] {
	const dirs: string[] = [];
	let dir = dirname(file);
	for (;;) {
		dirs.push(dir);
		if (dir === root) return dirs;
		const parent = dirname(dir);
		if (parent === dir) return dirs;
		dir = parent;
	}
}

/** The nearest `<dir>/<relative>` that exists, walking up from the file. */
function nearest(dirs: string[], relative: string, probe: Probe): string | null {
	for (const dir of dirs) {
		const candidate = join(dir, relative);
		if (probe.exists(candidate)) return candidate;
	}
	return null;
}

// ── Python: ruff ─────────────────────────────────────────────────────────────

/** A ruff config, nearest first: `ruff.toml`, `.ruff.toml`, or a pyproject with `[tool.ruff`. */
function ruffConfig(dirs: string[], probe: Probe): { path: string; text: string } | null {
	for (const dir of dirs) {
		for (const name of ["ruff.toml", ".ruff.toml"]) {
			const text = probe.read(join(dir, name));
			if (text !== null) return { path: join(dir, name), text };
		}
		const pyproject = probe.read(join(dir, "pyproject.toml"));
		if (pyproject !== null && /^\[tool\.ruff[\].]/m.test(pyproject)) return { path: join(dir, "pyproject.toml"), text: pyproject };
	}
	return null;
}

/**
 * The body of each TOML table, by header (`""` for keys before any header).
 * Enough TOML for the two questions asked here; not a parser.
 */
function tomlTables(text: string): Map<string, string> {
	const tables = new Map<string, string>();
	let name = "";
	let body: string[] = [];
	for (const line of text.split("\n")) {
		const header = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
		if (header) {
			tables.set(name, (tables.get(name) ?? "") + body.join("\n"));
			name = header[1].trim();
			body = [];
		} else {
			body.push(line);
		}
	}
	tables.set(name, (tables.get(name) ?? "") + body.join("\n"));
	return tables;
}

/**
 * Whether the repo's ruff config SELECTS the isort rules (`I`).
 *
 * `ruff check --fix --select I` sorts imports — a lint rule set, not part of
 * `ruff format`. Running it on a repo that never chose it would impose an
 * import order the repo does not have, so it runs only when ruff's own
 * `select`/`extend-select` names `I`. An `[…isort]` SETTINGS table is not a
 * selection, and a `select` under another tool's table (`[tool.flake8]`) is
 * not ruff's.
 */
export function ruffSelectsIsort(configText: string, file: "pyproject" | "ruff"): boolean {
	const ruffTables = file === "pyproject" ? ["tool.ruff", "tool.ruff.lint"] : ["", "lint"];
	const tables = tomlTables(configText);
	return ruffTables.some((name) => /(?:^|\n)\s*(?:extend-)?select\s*=\s*\[[^\]]*["']I["']/.test(tables.get(name) ?? ""));
}

/**
 * A pyproject that configures black and not ruff's formatter is a black repo
 * that happens to configure ruff's LINTER. ruff's output is close to black's,
 * not identical, so formatting with it would rewrite lines black then rewrites
 * back.
 */
function formatsWithBlack(dirs: string[], configText: string, probe: Probe): boolean {
	const tables = tomlTables(configText);
	if (tables.has("tool.ruff.format") || tables.has("format")) return false;
	return dirs.some((dir) => {
		const pyproject = probe.read(join(dir, "pyproject.toml"));
		return pyproject !== null && tomlTables(pyproject).has("tool.black");
	});
}

function planPython(file: string, dirs: string[], probe: Probe): Plan {
	const config = ruffConfig(dirs, probe);
	if (!config || formatsWithBlack(dirs, config.text, probe)) return { kind: "none" };
	const ruff = nearest(dirs, join(".venv", "bin", "ruff"), probe);
	if (!ruff) {
		return {
			kind: "missing",
			formatter: "ruff",
			key: `ruff:${config.path}`,
			reason: `ruff is configured (${config.path}) but there is no project-local ruff (\`.venv/bin/ruff\`) to run`,
		};
	}
	const cwd = dirname(config.path);
	const steps: Step[] = [];
	// isort first, then format: the order ruff's own docs give, because the
	// formatter normalises what the import sort leaves behind.
	if (ruffSelectsIsort(config.text, config.path.endsWith("pyproject.toml") ? "pyproject" : "ruff")) {
		steps.push({
			label: "ruff check --fix --select I",
			command: ruff,
			// --exit-zero: an import-order finding is fixed or it is not; either
			// way it is not a failure of THIS step. --force-exclude: honour the
			// config's excludes for a path passed explicitly, which ruff skips
			// otherwise.
			args: ["check", "--fix", "--select", "I", "--exit-zero", "--force-exclude", "--quiet", file],
			cwd,
		});
	}
	steps.push({ label: "ruff format", command: ruff, args: ["format", "--force-exclude", "--quiet", file], cwd });
	return { kind: "format", formatter: "ruff", steps };
}

// ── Go: gofmt / goimports ────────────────────────────────────────────────────

function planGo(file: string, dirs: string[], probe: Probe): Plan {
	const goMod = nearest(dirs, "go.mod", probe);
	if (!goMod) return { kind: "none" };
	const cwd = dirname(goMod);
	// Go's own tooling leaves vendored code and test fixtures alone; so does this.
	if (/\/(vendor|testdata)\//.test(file.slice(cwd.length))) return { kind: "none" };
	// goimports also adds and removes imports — more than formatting — so it
	// runs only when the repo's linter config names it.
	const lintConfig = [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"]
		.map((name) => probe.read(join(cwd, name)))
		.find((text) => text !== null);
	if (lintConfig && /\bgoimports\b/.test(lintConfig)) {
		const goimports = probe.which("goimports");
		if (goimports) {
			return { kind: "format", formatter: "goimports", steps: [{ label: "goimports", command: goimports, args: ["-w", file], cwd }] };
		}
	}
	const gofmt = probe.which("gofmt");
	if (!gofmt) {
		return { kind: "missing", formatter: "gofmt", key: `gofmt:${cwd}`, reason: `this is a Go module (${goMod}) but \`gofmt\` is not on PATH` };
	}
	return { kind: "format", formatter: "gofmt", steps: [{ label: "gofmt", command: gofmt, args: ["-w", file], cwd }] };
}

// ── JavaScript / TypeScript: oxfmt, biome, prettier ──────────────────────────

interface JsCandidate {
	formatter: "oxfmt" | "biome" | "prettier";
	/** For oxfmt: where its options live — its own rc file, or a vite-plus config's `fmt` block. */
	source?: "oxfmtrc" | "vite";
	config: string;
	/** Index in `dirs` — smaller is nearer to the file. */
	depth: number;
}

function jsCandidates(dirs: string[], probe: Probe): JsCandidate[] {
	const found: JsCandidate[] = [];
	dirs.forEach((dir, depth) => {
		for (const name of [".oxfmtrc.json", ".oxfmtrc.jsonc"]) {
			if (probe.exists(join(dir, name))) found.push({ formatter: "oxfmt", source: "oxfmtrc", config: join(dir, name), depth });
		}
		// vite-plus carries oxfmt's options under `fmt` in its own config.
		for (const name of VITE_CONFIGS) {
			const text = probe.read(join(dir, name));
			// A `fmt` PROPERTY (`fmt: {…}` or shorthand `{ fmt }`), not the word in a comment.
			if (text !== null && /vite-plus/.test(text) && /[{,]\s*fmt\s*[:,}]/.test(text)) {
				found.push({ formatter: "oxfmt", source: "vite", config: join(dir, name), depth });
			}
		}
		for (const name of ["biome.json", "biome.jsonc"]) {
			if (probe.exists(join(dir, name))) found.push({ formatter: "biome", config: join(dir, name), depth });
		}
		for (const name of PRETTIER_CONFIGS) {
			if (probe.exists(join(dir, name))) found.push({ formatter: "prettier", config: join(dir, name), depth });
		}
		// A top-level `prettier` KEY is a config; prettier in `devDependencies` is
		// an install, and a package that merely depends on it has not chosen it.
		if (declaresPrettier(probe.read(join(dir, "package.json")))) {
			found.push({ formatter: "prettier", config: join(dir, "package.json"), depth });
		}
	});
	return found;
}

function declaresPrettier(packageJson: string | null): boolean {
	if (packageJson === null) return false;
	try {
		const parsed = JSON.parse(packageJson) as Record<string, unknown> | null;
		return parsed !== null && typeof parsed === "object" && "prettier" in parsed;
	} catch {
		return false;
	}
}

const JS_PRECEDENCE = { oxfmt: 0, biome: 1, prettier: 2 } as const;

/**
 * The file types each formatter is run on. JS/TS only for prettier, although
 * it CAN format Markdown, YAML and JSON: a repo with a root `.prettierrc` very
 * often formats only its frontend sources (its lint-staged globs say so), and
 * reformatting its README on every edit is imposing exactly what this
 * extension must not. biome's JSON/CSS support is part of its own default
 * file set, so it keeps them.
 */
function extensionsOf(formatter: JsCandidate["formatter"]): string[] {
	if (formatter === "biome") return [...JS_FAMILY, ...BIOME_EXTRA];
	return JS_FAMILY;
}

/**
 * The NEAREST config that handles this file's extension wins; at the same
 * depth, oxfmt over biome over prettier. Nearest-wins is the same rule each of
 * these tools uses to find its own config, so a package that switched
 * formatter inside a monorepo is formatted the way it switched to.
 */
function planJs(file: string, dirs: string[], root: string, probe: Probe): Plan {
	const ext = extname(file).toLowerCase();
	const candidates = jsCandidates(dirs, probe)
		.filter((candidate) => extensionsOf(candidate.formatter).includes(ext))
		.sort((a, b) => a.depth - b.depth || JS_PRECEDENCE[a.formatter] - JS_PRECEDENCE[b.formatter]);
	const chosen = candidates[0];
	if (!chosen) return { kind: "none" };
	// The install at or above the declaring config first — the one that config
	// was written for — then any nearer to the file.
	const bin = (name: string) =>
		nearest(dirs.slice(chosen.depth), join("node_modules", ".bin", name), probe) ??
		nearest(dirs, join("node_modules", ".bin", name), probe);
	const missing = (what: string): Plan => ({
		kind: "missing",
		formatter: chosen.formatter,
		key: `${chosen.formatter}:${chosen.config}`,
		reason: `${chosen.formatter} is configured (${chosen.config}) but there is no project-local ${what} to run`,
	});

	if (chosen.formatter === "oxfmt") {
		// Which program reads WHICH config — the two are not interchangeable:
		//   - `vp fmt` reads only the `fmt` block of the vite.config nearest its
		//     cwd, never an .oxfmtrc.json ("No config found, using defaults").
		//   - oxfmt itself reads .oxfmtrc.json and cannot read a vite config
		//     ("JS functions cannot be represented").
		// And `node_modules/.bin/oxfmt` may be vite-plus's wrapper, which
		// refuses to format at all ("for IDE extension use only"), so oxfmt is
		// run from its own package, `node_modules/oxfmt/bin/oxfmt`.
		//
		// cwd = the declaring config's directory, for both: each resolves its
		// config and ignore patterns from the cwd, and a package with its own
		// vite.config.ts (pyERP's frontend/web, with no `fmt`) would otherwise be
		// formatted with defaults. --no-error-on-unmatched-pattern: an ignored
		// file is "nothing to do", not exit 2.
		const cwd = dirname(chosen.config);
		if (chosen.source === "oxfmtrc") {
			const oxfmt =
				nearest(dirs.slice(chosen.depth), join("node_modules", "oxfmt", "bin", "oxfmt"), probe) ??
				nearest(dirs, join("node_modules", "oxfmt", "bin", "oxfmt"), probe);
			if (!oxfmt) return missing("`node_modules/oxfmt`");
			return {
				kind: "format",
				formatter: "oxfmt",
				steps: [{ label: "oxfmt", command: oxfmt, args: ["--no-error-on-unmatched-pattern", file], cwd }],
			};
		}
		const vp = bin("vp");
		if (!vp) return missing("`vp` (vite-plus) in node_modules/.bin");
		return {
			kind: "format",
			formatter: "oxfmt",
			steps: [{ label: "vp fmt", command: vp, args: ["fmt", "--no-error-on-unmatched-pattern", file], cwd }],
		};
	}
	if (chosen.formatter === "biome") {
		const biome = bin("biome");
		if (!biome) return missing("`biome` in node_modules/.bin");
		return {
			kind: "format",
			formatter: "biome",
			steps: [
				{
					label: "biome format",
					command: biome,
					// An ignored or unsupported file is "nothing to do", not a failure.
					args: ["format", "--write", "--no-errors-on-unmatched", "--files-ignore-unknown=true", file],
					cwd: dirname(chosen.config),
				},
			],
		};
	}
	const prettier = bin("prettier");
	if (!prettier) return missing("`prettier` in node_modules/.bin");
	return {
		kind: "format",
		formatter: "prettier",
		steps: [
			{
				label: "prettier --write",
				command: prettier,
				// prettier finds its config from the FILE's path, but reads
				// .prettierignore from the cwd — so the repo root, where a
				// monorepo keeps it, not the package whose .prettierrc won.
				args: ["--write", "--ignore-unknown", file],
				cwd: root,
			},
		],
	};
}

/** Decide what, if anything, formats `file` (absolute). */
export function planFor(file: string, probe: Probe): Plan {
	const root = repoRootOf(file, probe);
	if (!root) return { kind: "none" };
	const dirs = ancestry(file, root);
	const ext = extname(file).toLowerCase();
	if (ext === ".py" || ext === ".pyi") return planPython(file, dirs, probe);
	if (ext === ".go") return planGo(file, dirs, probe);
	return planJs(file, dirs, root, probe);
}

/** The real filesystem, for `detect.ts`. */
export const realProbe: Probe = {
	read(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
	exists(path) {
		return existsSync(path);
	},
	which(name) {
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			if (!dir) continue;
			const candidate = join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				/* not here, or not runnable */
			}
		}
		return null;
	},
};

/** `PI_FORMAT_ON_EDIT=0` opts out — in pi and in the Claude adapter alike. */
export function disabled(env: Record<string, string | undefined>): boolean {
	return env.PI_FORMAT_ON_EDIT === "0";
}
