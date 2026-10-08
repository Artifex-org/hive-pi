/**
 * The Claude adapter's model-free hooks (pre-tool, prompt, post-tool) and the
 * CLI's runtime contract, exercised as the plugin runs them: `node
 * claude/cli.ts hook <name>` with Claude Code's hook JSON on stdin.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { preToolDecision } from "../claude/hooks/pre-tool.ts";
import { DEFAULT_CONTROL, type Control } from "../claude/state.ts";
import { makeLaunch, REPO, runCli, type LaunchEnv } from "./claude-harness.ts";

let launch: LaunchEnv;
afterEach(() => {
	launch = undefined as unknown as LaunchEnv;
});

function claudeFiles(dir = join(REPO, "claude")): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? claudeFiles(path) : name.endsWith(".ts") ? [path] : [];
	});
}

/**
 * A loader hook that refuses any bare-specifier import made FROM this
 * checkout — what a node sees, where the checkout has no node_modules the
 * adapter could lean on (`@earendil-works/*`, typebox, yaml …).
 */
function blockerFile(root: string): string {
	const file = join(root, "block-bare-imports.mjs");
	writeFileSync(
		file,
		`import { registerHooks } from "node:module";
const ROOT = ${JSON.stringify(pathToFileURL(REPO).href + "/")};
registerHooks({
  resolve(spec, ctx, next) {
    const bare = !spec.startsWith("node:") && !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("file:");
    if (bare && ctx.parentURL && ctx.parentURL.startsWith(ROOT) && !ctx.parentURL.includes("/node_modules/")) {
      throw new Error("bare import " + spec + " from " + ctx.parentURL);
    }
    return next(spec, ctx);
  },
});
`,
	);
	return file;
}

describe("claude/cli.ts runtime contract", () => {
	it("answers --help under plain node with every bare import from the checkout refused", async () => {
		launch = makeLaunch();
		const result = await runCli(["--help"], launch.env, "", REPO, ["--import", blockerFile(launch.root)]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("hook stop");
	});

	it("loads EVERY adapter module under that resolver — no runtime import of @earendil-works/*, typebox or yaml", () => {
		launch = makeLaunch();
		// cli.ts runs main() on import, so it is covered by the --help case.
		const modules = claudeFiles().filter((file) => !file.endsWith("cli.ts"));
		const script = `Promise.all(${JSON.stringify(modules.map((m) => pathToFileURL(m).href))}.map((u) => import(u))).then(() => console.log("loaded"))`;
		const out = execFileSync(process.execPath, ["--import", blockerFile(launch.root), "-e", script], { cwd: REPO, encoding: "utf8" });
		expect(out.trim()).toBe("loaded");
		expect(modules.map((m) => relative(REPO, m))).toContain("claude/mcp/subagent-tool.ts");
		// The resolver does bite: the pi-bound extension imports pi at runtime.
		const piBound = `import(${JSON.stringify(pathToFileURL(join(REPO, "extensions", "subagent", "index.ts")).href)}).then(() => console.log("loaded"), (e) => console.log(String(e.message)))`;
		const refused = execFileSync(process.execPath, ["--import", blockerFile(launch.root), "-e", piBound], { cwd: REPO, encoding: "utf8" });
		expect(refused).toContain("bare import @earendil-works/");
	});

	it("exits 2 with usage when no command is given", async () => {
		launch = makeLaunch();
		const result = await runCli([], launch.env);
		expect(result.code).toBe(2);
		expect(result.stdout).toContain("usage:");
	});
});

const control = (opMode: Control["opMode"]): Control => ({ ...DEFAULT_CONTROL, opMode });

describe("hook pre-tool", () => {
	it("denies a write in discuss mode with pi's own refusal", async () => {
		launch = makeLaunch();
		launch.writeControl({ opMode: "discuss" });
		const result = await runCli(["hook", "pre-tool"], launch.env, JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" }, cwd: "/tmp" }));
		expect(result.code).toBe(0);
		const out = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> };
		expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("writes to disk");
	});

	it("lets a read-only shell command through in discuss mode and refuses a mutating one", async () => {
		launch = makeLaunch();
		launch.writeControl({ opMode: "discuss" });
		const ls = await runCli(["hook", "pre-tool"], launch.env, JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: "/tmp" }));
		expect(ls.stdout).toBe("");
		const rm = await runCli(["hook", "pre-tool"], launch.env, JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf build" }, cwd: "/tmp" }));
		expect(JSON.parse(rm.stdout).hookSpecificOutput.permissionDecisionReason).toContain("Discussion mode allows only read-only shell commands");
	});

	it("applies plan mode's gate", () => {
		expect(preToolDecision({ tool_name: "Write", tool_input: { file_path: "/tmp/a" } }, control("plan"))).toMatchObject({
			hookSpecificOutput: { permissionDecision: "deny" },
		});
		expect(preToolDecision({ tool_name: "Bash", tool_input: { command: "echo hi > f" } }, control("plan"))).toMatchObject({
			hookSpecificOutput: { permissionDecision: "deny" },
		});
		expect(preToolDecision({ tool_name: "Bash", tool_input: { command: "git status" } }, control("plan"))).toBeNull();
	});

	it("does not gate build, bugfix once a root cause is recorded, or Claude tools pi has no name for", () => {
		expect(preToolDecision({ tool_name: "Edit", tool_input: { file_path: "/tmp/a" } }, control("build"))).toBeNull();
		expect(preToolDecision({ tool_name: "Edit", tool_input: { file_path: "/tmp/a" } }, control("bugfix"), true)).toBeNull();
		expect(preToolDecision({ tool_name: "Bash", tool_input: { command: "rm -rf build" } }, control("bugfix"))).toBeNull();
		expect(preToolDecision({ tool_name: "WebFetch", tool_input: { url: "https://x" } }, control("discuss"))).toBeNull();
		expect(preToolDecision({ tool_name: "mcp__hive__get_run", tool_input: {} }, control("discuss"))).toBeNull();
	});

	it("only ever denies or stays silent — never allow or ask (a Hive launch has no human at the prompt)", () => {
		const modes: Control["opMode"][] = ["build", "plan", "discuss", "bugfix", "orchestrate"];
		const calls = [
			{ tool_name: "Edit", tool_input: { file_path: "/tmp/a" } },
			{ tool_name: "Write", tool_input: { file_path: "/tmp/a" } },
			{ tool_name: "MultiEdit", tool_input: { file_path: "/tmp/a" } },
			{ tool_name: "NotebookEdit", tool_input: { notebook_path: "/tmp/a.ipynb" } },
			{ tool_name: "Bash", tool_input: { command: "curl -X POST x" } },
			{ tool_name: "Bash", tool_input: { command: "cat x" } },
			{ tool_name: "Read", tool_input: { file_path: "/tmp/a" } },
		];
		for (const mode of modes) {
			for (const call of calls) {
				const out = preToolDecision(call, control(mode)) as { hookSpecificOutput?: { permissionDecision?: string } } | null;
				if (out) expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
			}
		}
	});

	it("blocks an edit in a guarded main worktree with the worktree guard's own message", () => {
		launch = makeLaunch();
		const repo = join(launch.root, "guarded");
		mkdirSync(repo);
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(repo, ".worktree-guard"), "");
		const out = preToolDecision({ tool_name: "Write", tool_input: { file_path: "src/a.ts" }, cwd: repo }, DEFAULT_CONTROL) as {
			hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
		};
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("worktree");
	});

	it("fails CLOSED on an unreadable control.json — a deny, never a silent pass as build", async () => {
		launch = makeLaunch();
		launch.writeControl({ opMode: "yolo" });
		const result = await runCli(["hook", "pre-tool"], launch.env, JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/tmp/a" } }));
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("unknown opMode");
		const out = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("unknown opMode");
	});

	it("fails closed on malformed hook input too", async () => {
		launch = makeLaunch();
		const result = await runCli(["hook", "pre-tool"], launch.env, "{not json");
		expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
	});
});

describe("hook prompt", () => {
	it("adds the op mode's prompt in discuss and bugfix, nothing otherwise", async () => {
		launch = makeLaunch();
		launch.writeControl({ opMode: "discuss" });
		const discuss = JSON.parse((await runCli(["hook", "prompt"], launch.env, JSON.stringify({ prompt: "why?" }))).stdout);
		expect(discuss.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
		expect(discuss.hookSpecificOutput.additionalContext).toContain("# Discussion mode");
		launch.writeControl({ opMode: "bugfix" });
		const bugfix = JSON.parse((await runCli(["hook", "prompt"], launch.env, "{}")).stdout);
		expect(bugfix.hookSpecificOutput.additionalContext).toContain("# Bugfix mode");
		launch.writeControl({ opMode: "plan" });
		expect((await runCli(["hook", "prompt"], launch.env, "{}")).stdout).toBe("");
	});

	it("speaks nothing with no control.json (defaults: build)", async () => {
		launch = makeLaunch();
		expect((await runCli(["hook", "prompt"], launch.env, "{}")).stdout).toBe("");
	});
});

describe("hook post-tool", () => {
	function prettierRepo(root: string): string {
		const repo = join(root, "fmt");
		mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fmt", prettier: {} }));
		writeFileSync(join(repo, ".prettierrc"), "{}");
		// A "prettier" that uppercases the file it is handed.
		const bin = join(repo, "node_modules", ".bin", "prettier");
		writeFileSync(bin, `#!${process.execPath}\nconst fs=require("fs");const f=process.argv[process.argv.length-1];fs.writeFileSync(f, fs.readFileSync(f,"utf8").toUpperCase());\n`);
		chmodSync(bin, 0o755);
		return repo;
	}

	it("formats the edited file with the repo's formatter and says which lines moved", async () => {
		launch = makeLaunch();
		const repo = prettierRepo(launch.root);
		const file = join(repo, "a.ts");
		writeFileSync(file, "const a = 1;\n");
		const result = await runCli(["hook", "post-tool"], launch.env, JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: repo }));
		expect(result.stderr).toBe("");
		const out = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
		expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
		expect(out.hookSpecificOutput.additionalContext).toContain("[format-on-edit]");
		expect(readFileSync(file, "utf8")).toBe("CONST A = 1;\n");
	});

	it("is silent for a tool that writes nothing", async () => {
		launch = makeLaunch();
		const result = await runCli(["hook", "post-tool"], launch.env, JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hostname" } }));
		expect(result.stdout).toBe("");
		expect(result.code).toBe(0);
	});
});
