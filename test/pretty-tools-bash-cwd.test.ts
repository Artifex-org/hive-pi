/**
 * `bash` takes a `cwd`, and the harness runs the command there.
 *
 * WHY THIS IS A SCHEMA CHANGE AND NOT ANOTHER REPAIR. pi's built-in `bashSchema`
 * is `{command, timeout}`, so a `cwd` the model passes is accepted by the wire
 * format and dropped on the floor. `toolcwd` used to catch that at `tool_call`
 * and append a sentence to the RESULT — which works, and arrives one turn after
 * the call it was meant to prevent. Thirty papercuts over 2026-08-21..28 asked
 * for the parameter itself; 23 of them complain about exactly that lateness.
 *
 * An extension tool REPLACES a built-in of the same name (`agent-session.js`
 * builds the registry from the built-ins, then `toolRegistry.set(tool.name,
 * tool)` for every extension tool), and `pretty-tools` already registers
 * `bash`. So the parameter is ours to declare.
 *
 * These tests run the REAL tool against a real shell, with pty mode off — the
 * fallback path — because that is the one that can be driven without a tty and
 * both paths share the same rewrite.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool, createBashToolDefinition, createLocalBashOperations, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import prettyTools from "../extensions/pretty-tools.ts";
import { createFakePi } from "./fake-pi.ts";
import { realBashAvailable } from "./require-tools.ts";

type Executable = {
	parameters: { properties?: Record<string, unknown> };
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx?: ExtensionToolContext,
	) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

function bashTool(): Executable {
	const fake = createFakePi();
	prettyTools(fake.api as unknown as ExtensionAPI);
	const registered = fake.tools.find((t) => t.name === "bash");
	if (!registered) throw new Error("pretty-tools registered no bash tool");
	return registered.definition as unknown as Executable;
}

async function runBash(params: Record<string, unknown>, ctx?: ExtensionToolContext): Promise<string> {
	const result = await bashTool().execute("c1", params, new AbortController().signal, undefined, ctx);
	return result.content.map((part) => part.text ?? "").join("");
}

describe.runIf(realBashAvailable())("the bash tool's cwd", () => {
	let dir: string;
	let saved: { pty: string | undefined; surface: string | undefined };

	beforeEach(() => {
		// The fallback path deliberately: `ptyAvailable()` reads these two, and a
		// developer running the suite from a launched agent has the second set.
		saved = { pty: process.env.PI_PTY_BASH, surface: process.env.HIVE_TERMINAL_SURFACE_DIR };
		delete process.env.PI_PTY_BASH;
		delete process.env.HIVE_TERMINAL_SURFACE_DIR;
		// realpath because /tmp is a symlink on some hosts and `pwd` reports the
		// path it was given, not the one mkdtemp returned.
		dir = realpathSync(mkdtempSync(`${tmpdir()}/bash-cwd-`));
	});

	afterEach(() => {
		if (saved.pty === undefined) delete process.env.PI_PTY_BASH;
		else process.env.PI_PTY_BASH = saved.pty;
		if (saved.surface === undefined) delete process.env.HIVE_TERMINAL_SURFACE_DIR;
		else process.env.HIVE_TERMINAL_SURFACE_DIR = saved.surface;
		rmSync(dir, { recursive: true, force: true });
	});

	// The declaration is what stops the call being made wrong in the first place.
	it("declares cwd on the schema the model is shown", () => {
		const properties = bashTool().parameters.properties ?? {};
		expect(Object.keys(properties)).toContain("cwd");
		expect(Object.keys(properties)).toContain("command");
	});

	it("runs the command in the directory it was given", async () => {
		const out = await runBash({ command: "pwd", cwd: dir });
		expect(out).toContain(dir);
		expect(out).not.toContain(process.cwd());
	});

	// Seven of the thirty papercuts spelled it `workdir`, got no rewrite and no
	// warning, and read an answer about the session's checkout as the truth.
	it("honours workdir too, and says which spelling it wanted", async () => {
		const out = await runBash({ command: "pwd", workdir: dir });
		expect(out).toContain(dir);
		expect(out).toContain("[harness]");
		expect(out).toContain("`cwd`");
	});

	it("proves the public SDK exec seam can override child env and redact before accumulation", async () => {
		const token = "SYNTHETIC_CREDENTIAL_SENTINEL_9f2a";
		const before = process.env.SYNTHETIC_TEST_SECRET;
		const base = createLocalBashOperations();
		const seen: string[] = [];
		const operations = {
			...base,
			exec(command: string, cwd: string, options: Parameters<typeof base.exec>[2]) {
				return base.exec(command, cwd, {
					...options,
					env: { ...options.env, SYNTHETIC_TEST_SECRET: token },
					onData: (chunk) => {
						const redacted = Buffer.from(chunk.toString().split(token).join("[redacted]"));
						seen.push(redacted.toString());
						options.onData(redacted);
					},
				});
			},
		};
		const tool = createBashToolDefinition(dir, { operations });
		const result = await tool.execute("credential-seam", {
			command: `printf '%s' "$SYNTHETIC_TEST_SECRET"`,
		}, new AbortController().signal, undefined, {
			cwd: dir,
			model: undefined,
			sessionManager: { getSessionId: () => "synthetic-session", getSessionFile: () => undefined },
		} as unknown as ExtensionToolContext);
		const output = result.content.map((part) => ("text" in part ? part.text : "")).join("");
		expect(seen.join("")).toBe("[redacted]");
		expect(output).toBe("[redacted]");
		expect(process.env.SYNTHETIC_TEST_SECRET).toBe(before);
	});

	it("forwards SDK session metadata and context cwd to the stock bash backend", async () => {
		const context = {
			cwd: dir,
			model: { provider: "synthetic-provider", id: "synthetic-model" },
			thinkingLevel: "high",
			sessionManager: { getSessionId: () => "synthetic-session", getSessionFile: () => "/tmp/synthetic-session.jsonl" },
		} as unknown as ExtensionToolContext;
		const out = await runBash({
			command: `printf '%s|%s|%s|%s|%s|%s' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL" "$PWD"`,
		}, context);
		expect(out).toContain(`synthetic-session|/tmp/synthetic-session.jsonl|synthetic-provider|synthetic-model|high|${dir}`);
	});

	it("preserves inherited and non-enumerable session fields with explicit cwd", async () => {
		const context = Object.create({
			model: { provider: "synthetic-provider", id: "synthetic-model" },
			sessionManager: { getSessionId: () => "inherited-session", getSessionFile: () => undefined },
		}, {
			cwd: { value: process.cwd() },
			thinkingLevel: { value: "high" },
		}) as ExtensionToolContext;
		const out = await runBash({
			command: `printf "%s|%s|%s|%s" "$PI_SESSION_ID" "$PI_PROVIDER" "$PI_REASONING_LEVEL" "$PWD"`,
			cwd: dir,
		}, context);
		expect(out).toContain(`inherited-session|synthetic-provider|high|${dir}`);
	});

	it("explicit cwd takes precedence over SDK context cwd", async () => {
		const other = realpathSync(mkdtempSync(`${tmpdir()}/bash-cwd-explicit-`));
		try {
			const context = { cwd: dir, sessionManager: { getSessionId: () => "synthetic-session", getSessionFile: () => undefined } } as unknown as ExtensionToolContext;
			const out = await runBash({ command: "pwd", cwd: other }, context);
			expect(out).toContain(other);
			expect(out).not.toContain(dir);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("leaves a call that named no directory exactly where it was", async () => {
		const out = await runBash({ command: "pwd" });
		expect(out).toContain(process.cwd());
		expect(out).not.toContain("[harness]");
	});
});
