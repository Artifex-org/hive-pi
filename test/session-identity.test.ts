import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import sessionIdentity, { SESSION_IDENTITY_ENTRY } from "../extensions/hive-remote/sessionIdentity.ts";
import { SESSION_IDENTITY_INITIAL_CHANNEL, SESSION_PLAN_INTRO_CHANNEL } from "../extensions/hive-remote/sessionIdentityBus.ts";
import { createFakePi } from "./fake-pi.ts";

describe("canonical session context", () => {
	it("creates a provisional intro from the true opening input without creating a plan", async () => {
		const fake = createFakePi();
		sessionIdentity(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });
		fake.api.events.emit(SESSION_IDENTITY_INITIAL_CHANNEL, { title: "Inspect [url]", prompt: "Inspect https://private.example" });
		const saved = fake.entries.find((entry) => entry.customType === SESSION_IDENTITY_ENTRY)?.data as Record<string, unknown>;
		expect(saved).toMatchObject({ title: "Inspect [url]", provisional: true });
		expect(saved.description).toContain("Goal: Inspect [url]");
		expect(saved.description).not.toContain("private.example");
		expect(fake.entries.some((entry) => entry.customType === "plan")).toBe(false);
		const prompt = await fake.emit({ type: "before_agent_start" });
		expect(fake.tools.some((tool) => tool.name === "session_context")).toBe(true);
		expect(prompt).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ content: expect.stringContaining("even when no formal plan") }) }));
		expect(await fake.emit({ type: "before_agent_start" })).toEqual([undefined]);
	});

	it("updates canonical description from the formal plan's intro prose", async () => {
		const fake = createFakePi();
		sessionIdentity(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });
		fake.api.events.emit(SESSION_IDENTITY_INITIAL_CHANNEL, { title: "Implement context", prompt: "Implement context" });
		fake.api.events.emit(SESSION_PLAN_INTRO_CHANNEL, { description: "Goal: persist context. Approach: connect plan prose." });
		const saved = fake.entries.filter((entry) => entry.customType === SESSION_IDENTITY_ENTRY).at(-1)!.data as Record<string, unknown>;
		expect(saved).toMatchObject({ provisional: false, description: "Goal: persist context. Approach: connect plan prose." });
	});

	it("restores canonical identity from the active branch on resume", async () => {
		const fake = createFakePi();
		sessionIdentity(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, { branch: [{ type: "custom", customType: SESSION_IDENTITY_ENTRY, data: {
			title: "Resumed task", description: "Goal: continue. Approach: verify.", provisional: false, revision: 3,
		} }] });
		const result = await fake.emit({ type: "before_agent_start" });
		expect(result).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ content: expect.stringContaining("Resumed task") }) }));
	});
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("session_context is declared to the model it is named to", () => {
	it("is active, and listed in the system prompt, in a real pi session", async () => {
		// HIV-3906: registered `deferred` by the loadout policy, so the kickoff
		// message named a tool the claude-sdk launch was never given.
		const root = await mkdtemp(join(tmpdir(), "session-identity-"));
		cleanups.push(() => rm(root, { force: true, recursive: true }));
		const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, extensionFactories: [sessionIdentity],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings,
			resourceLoader: loader, sessionManager: SessionManager.inMemory(root) });
		cleanups.push(async () => { session.dispose(); });
		await session.bindExtensions({ mode: "json" });
		expect(session.getActiveToolNames()).toContain("session_context");
		expect(session.systemPrompt).toContain("- session_context: At kickoff, define the goal and approach");
	});

	it("never names session_context once the tool is not active", async () => {
		const fake = createFakePi();
		sessionIdentity(fake.api);
		await fake.emit({ type: "session_start", reason: "new" });
		expect(fake.api.getActiveTools()).toContain("session_context");
		fake.api.setActiveTools([]); // a mode narrowed the set
		expect(await fake.emit({ type: "before_agent_start" })).toEqual([undefined]);

		await fake.emit({ type: "session_start", reason: "resume" }, { branch: [{ type: "custom", customType: SESSION_IDENTITY_ENTRY, data: {
			title: "Resumed task", description: "Goal: continue. Approach: verify.", provisional: true, revision: 1,
		} }] });
		fake.api.setActiveTools([]);
		const [result] = await fake.emit({ type: "before_agent_start" }) as [{ message: { content: string } }];
		expect(result.message.content).toContain("Resumed task");
		expect(result.message.content).not.toContain("session_context");
	});
});
