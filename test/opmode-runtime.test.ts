/** The actual pi loader/runner and reload path, with no model requests. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import opmode from "../extensions/opmode/index.ts";
import plan from "../extensions/plan/index.ts";

it.each([false, true])("enforces launch flags through real rebind/reload and restores editors (planFirst=%s)", async planFirst => {
	const dir = await mkdtemp(join(tmpdir(), "plan-runtime-"));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const model = runtime.getModels()[0];
	if (!model) throw new Error("No built-in model in fixture runtime");
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: planFirst ? [plan, opmode] : [opmode, plan],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(),
	});
	try {
		expect(extensionsResult.errors).toEqual([]);
		extensionsResult.runtime.flagValues.set("op-mode", "plan");
		const denied = () => session.extensionRunner.emitToolCall({
			type: "tool_call", toolCallId: "write-test", toolName: "write", input: { path: "new.ts", content: "x" },
		});
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
		expect(await denied()).toMatchObject({ block: true });
		await session.bindExtensions({ mode: "print" });
		expect(await denied()).toMatchObject({ block: true });
		const oldRunner = session.extensionRunner;
		const sessionId = session.sessionManager.getSessionId();
		// Reload WHILE restricted: the old runtime must not carry a narrowed
		// snapshot into the new plan owner's eventual restoration baseline.
		await session.reload();
		expect(session.extensionRunner).not.toBe(oldRunner);
		expect(session.sessionManager.getSessionId()).toBe(sessionId);
		expect(session.extensionRunner.getFlagValues().get("op-mode")).toBe("plan");
		expect(await denied()).toMatchObject({ block: true });
		expect(session.getActiveToolNames()).not.toContain("write");
		await session.prompt("/plan exit");
		expect((await denied())?.block).not.toBe(true);
		for (const name of ["read", "bash", "write", "edit"]) expect(session.getActiveToolNames()).toContain(name);
		expect(errors).toEqual([]);
	} finally {
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
