/**
 * Overriding a built-in tool must not strip what pi uses from its definition.
 *
 * pretty-tools re-registers read/bash/edit/write/grep/find/ls under the
 * built-in names, which REPLACES the built-ins. Copying only description and
 * parameters dropped bash's system-prompt lines (promptSnippet /
 * promptGuidelines), edit's prepareArguments and the strict-schema hint.
 */

import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import prettyTools from "../extensions/pretty-tools.ts";
import { createFakePi } from "./fake-pi.ts";

function registered(name: string): Record<string, unknown> {
	const pi = createFakePi();
	prettyTools(pi.api);
	const tool = pi.tools.find((t) => t.name === name);
	if (!tool) throw new Error(`pretty-tools did not register ${name}`);
	return tool.definition;
}

describe("pretty-tools keeps the built-in tool metadata", () => {
	it("bash keeps its system-prompt snippet and guidelines", () => {
		// AgentTool's type omits these, but the runtime definition carries them.
		const builtin = createBashTool(process.cwd()) as unknown as { promptSnippet?: string; promptGuidelines?: string[] };
		const ours = registered("bash");
		expect(builtin.promptSnippet).toBeTruthy();
		expect(ours.promptSnippet).toBe(builtin.promptSnippet);
		expect(ours.promptGuidelines).toEqual(builtin.promptGuidelines);
	});

	it("edit keeps prepareArguments, pi's normalisation of the shapes models send", () => {
		const builtin = createEditTool(process.cwd());
		expect(typeof builtin.prepareArguments).toBe("function");
		expect(registered("edit").prepareArguments).toBe(builtin.prepareArguments);
	});

	it.each([
		["read", createReadTool],
		["edit", createEditTool],
		["write", createWriteTool],
	] as const)("%s keeps its constrained-sampling hint", (name, create) => {
		expect(registered(name).constrainedSampling).toEqual(create(process.cwd()).constrainedSampling);
	});

	it("does not claim the built-in bash outputSchema — our bash returns its own shape", () => {
		expect(registered("bash").outputSchema).toBeUndefined();
	});
});
