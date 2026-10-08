/** Exercise pi's real QuickJS bridge against the harness's actual bash registration. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadoutPrompt } from "../extensions/loadout/index.ts";
import prettyTools from "../extensions/pretty-tools.ts";
import { createFakePi } from "./fake-pi.ts";
import { realBashAvailable } from "./require-tools.ts";

function bridge() {
	const pi = createFakePi();
	prettyTools(pi.api);
	createCodemodeExtension({ models: false })(pi.api);
	const definition = (name: string) => {
		const found = pi.tools.find((tool) => tool.name === name);
		if (!found) throw new Error(`Missing registration: ${name}`);
		return found.definition as unknown as ToolDefinition;
	};
	const bash = definition("bash");
	const codemode = definition("codemode");
	let executions = 0;
	// A narrow session seam: real codemode performs discovery and converts tool
	// results; real bash executes. This is not a mock of the permission pipeline.
	const ctx: Pick<ExtensionToolContext, "cwd" | "tools" | "executeTool"> & {
		sessionManager: Pick<ExtensionToolContext["sessionManager"], "getBranch" | "getSessionId" | "getSessionFile">;
	} = {
		cwd: process.cwd(),
		tools: [bash as unknown as AgentTool],
		sessionManager: { getBranch: () => [], getSessionId: () => "synthetic-contract", getSessionFile: () => undefined },
		async executeTool(name, args, options) {
			executions++;
			// QuickJS serializes tool arguments as JSON; executeTool's public
			// input is unknown, while the recorded tool call requires JsonObject.
			const toolCall = { type: "toolCall" as const, id: `contract/${executions}`, name, arguments: args as JsonObject };
			try {
				const result = await bash.execute(toolCall.id, args, options?.signal, undefined, ctx as ExtensionToolContext);
				return { toolCall, result, isError: false };
			} catch (error) {
				return { toolCall, result: { content: [{ type: "text" as const, text: String(error) }], details: undefined }, isError: true };
			}
		},
	};
	return {
		bash,
		executions: () => executions,
		async run(code: string) {
			const result = await codemode.execute("contract", { code }, new AbortController().signal, undefined, ctx as ExtensionToolContext);
			return { result, text: result.content.map((part) => "text" in part ? part.text : "").join("\n") };
		},
	};
}

describe.runIf(realBashAvailable())("codemode's tool boundary", () => {
	beforeEach(() => {
		vi.stubEnv("PI_PTY_BASH", undefined);
		vi.stubEnv("HIVE_TERMINAL_SURFACE_DIR", undefined);
	});
	afterEach(() => vi.unstubAllEnvs());

	it("a missing discovery member fails without executing any tool", async () => {
		const harness = bridge();
		const { result, text } = await harness.run('text(await tools.tool_search({query:"bash"}));');
		expect(result.isError).toBe(true);
		expect(text).toContain("tools.tool_search does not exist");
		expect(harness.executions()).toBe(0);
	});

	it("the prompt's awaited discovery works and describes bash's actual contract", async () => {
		const harness = bridge();
		const prompt = loadoutPrompt(["session_grep"]);
		const example = /`(await searchTools\("<words>"\))`/.exec(prompt)?.[1];
		expect(example).toBeTruthy();
		const { result, text } = await harness.run(`
			const hits = ${example?.replace("<words>", "bash")};
			text(hits.map(hit => hit.name));
			text(await describeTool(hits[0].name));
			text(typeof await tools.bash({command: "printf contract-ok", timeout: 5}));
		`);
		expect(result.isError, text).not.toBe(true);
		expect(text).toContain('"bash"');
		expect(text).toContain("returns text on success");
		expect(text).toContain("Promise<string>");
		expect(text).toContain("string");
		expect(harness.executions()).toBe(1);
	});

	it("an explicit shell timeout remains rejected and its diagnostic survives stringification", async () => {
		const harness = bridge();
		const { result, text } = await harness.run(`
			const [r] = await Promise.allSettled([tools.bash({command: "sleep 2", timeout: 0.05})]);
			text(r.status);
			if (r.status === "rejected") text(String(r.reason));
		`);
		expect(result.isError, text).not.toBe(true);
		expect(text).toContain("rejected");
		expect(text).toContain("Command timed out after 0.05 seconds");
	});

	it("keeps a nonzero shell exit rejected while allSettled retains sibling output and error text", async () => {
		const harness = bridge();
		const { result, text } = await harness.run(`
			const results = await Promise.allSettled([
				tools.bash({command: "printf sibling-ok", timeout: 5}),
				tools.bash({command: "printf failure-marker; exit 7", timeout: 5})
			]);
			text(results.map(r => r.status === "fulfilled" ? r.value : String(r.reason)));
		`);
		expect(result.isError, text).not.toBe(true);
		expect(text).toContain("sibling-ok");
		expect(text).toContain("failure-marker");
		expect(text).toContain("Command exited with code 7");
		expect(harness.executions()).toBe(2);
		expect(harness.bash.outputSchema).toBeUndefined();
		expect(harness.bash.description).toContain("String(result.reason)");
		expect(harness.bash.description).toContain("background_bash");
	});
});
