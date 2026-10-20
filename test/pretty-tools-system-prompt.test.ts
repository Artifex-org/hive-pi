/**
 * The system prompt a real pi session builds with pretty-tools loaded must
 * still list the file tools and carry their guidelines.
 *
 * pretty-tools replaces read/bash/edit/write/grep/find/ls. It used to copy the
 * prompt metadata from pi's `create*Tool` AgentTools, which `wrapToolDefinition`
 * strips of `promptSnippet`/`promptGuidelines`, so every file tool except bash
 * vanished from `Available tools` and "Use read to examine files instead of cat
 * or sed" never reached the model.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentSession,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import prettyTools from "../extensions/pretty-tools.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

async function systemPrompt(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pretty-tools-prompt-"));
	cleanups.push(() => rm(root, { force: true, recursive: true }));
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, extensionFactories: [prettyTools],
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings,
		resourceLoader: loader, tools: TOOLS, sessionManager: SessionManager.inMemory(root) });
	cleanups.push(async () => { session.dispose(); });
	await session.bindExtensions({ mode: "json" });
	return session.systemPrompt;
}

describe("pretty-tools in the real system prompt", () => {
	it("lists read, edit and write with pi's own snippets", async () => {
		const prompt = await systemPrompt();
		for (const def of [createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition]) {
			const { name, promptSnippet } = def(process.cwd());
			expect(promptSnippet).toBeTruthy();
			expect(prompt).toContain(`- ${name}: ${promptSnippet}`);
		}
	});

	it("carries the read, edit and write guidelines", async () => {
		const prompt = await systemPrompt();
		expect(prompt).toContain("Use read to examine files instead of cat or sed.");
		for (const def of [createEditToolDefinition, createWriteToolDefinition]) {
			const guidelines = def(process.cwd()).promptGuidelines ?? [];
			expect(guidelines.length).toBeGreaterThan(0);
			for (const line of guidelines) expect(prompt).toContain(line);
		}
	});
});
