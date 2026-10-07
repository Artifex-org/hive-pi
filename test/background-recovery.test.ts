import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJob, finishJob } from "../extensions/background/jobs.ts";
import { JOB_RECORD, jobRecord, recoverJobs, lastSubagentId } from "../extensions/background/journal.ts";
import { realBashAvailable } from "./require-tools.ts";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import background from "../extensions/background/index.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

async function inspect(pi: FakePi, name: string, params: Record<string, unknown> = {}): Promise<string> {
	const tool = pi.tools.find((entry) => entry.name === name)!;
	const execute = (tool.definition as { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }).execute;
	return (await execute("id", params, undefined, undefined, { mode: "rpc", cwd: process.cwd() })).content[0].text;
}
async function untilNotices(pi: FakePi, count: number): Promise<void> {
	const deadline = Date.now() + 3000;
	while (pi.messages.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(pi.messages).toHaveLength(count);
}

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const running = createJob({ id: "bg-1", what: "check", kind: "bash", detail: "echo", startedAtMs: 1 });
const completed = finishJob({ ...running, output: "retained-output" }, { status: "done", exitCode: 0, endedAtMs: 2 });
const entry = (job = completed, sessionId = "owner", executionId = "execution") => ({
	type: "custom", customType: JOB_RECORD, data: jobRecord(sessionId, executionId, job),
});
const notice = (sessionId = "owner", executionId = "execution") => ({
	type: "custom_message", customType: "background", details: { sessionId, executionId, status: "done" },
});

it("restores evidence and reconciles only a persisted notice for this execution", () => {
	expect(recoverJobs([entry()], "owner")[0].job).toMatchObject({ status: "done", output: "retained-output", notified: false });
	expect(recoverJobs([entry(), notice()], "owner")[0].job.notified).toBe(true);
	expect(recoverJobs([entry(), notice("owner", "old-execution")], "owner")[0].job.notified).toBe(false);
	expect(recoverJobs([entry(), notice("other")], "owner")[0].job.notified).toBe(false);
});
it("never inherits ownership in a new session/fork or recovers abandoned branches", () => {
	expect(recoverJobs([entry()], "other")).toEqual([]);
	expect(recoverJobs([], "owner")).toEqual([]);
});
it("unfinished evidence is unconfirmed, never success, stopped, or a replay instruction", () => {
	const recovered = recoverJobs([entry(running)], "owner")[0].job;
	expect(recovered.status).toBe("unconfirmed");
	expect(recovered.exitCode).toBeUndefined();
	expect(recovered.output).toContain("NOT restarted");
	expect(recovered.output).toContain("external effects");
});
it("rejects corrupt records instead of pretending that the job never existed", () => {
	expect(() => recoverJobs([{ type: "custom", customType: JOB_RECORD, data: {} }], "owner")).toThrow("Invalid background");
});
it("keeps delegated ids monotonic after a reload", () => {
	expect(lastSubagentId([entry({ ...completed, id: "sub-9", kind: "subagent" })], "owner")).toBe(9);
	expect(lastSubagentId([entry({ ...completed, id: "sub-9" })], "other")).toBe(0);
});

it("restores a recorded result in the real runtime without waking through plan approval", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-background-approval-"));
	directories.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	manager.appendMessage({ role: "user", content: "Prepare a plan", timestamp: Date.now() });
	manager.appendCustomEntry(JOB_RECORD, jobRecord(manager.getSessionId(), "execution", completed));
	manager.appendMessage({ ...fauxAssistantMessage(""), content: [{ type: "toolCall", id: "approval", name: "plan_ready", arguments: {} }], stopReason: "toolUse" });
	manager.appendMessage({ role: "toolResult", toolCallId: "approval", toolName: "plan_ready", content: [{ type: "text", text: "Plan is ready and awaiting approval" }], isError: false, timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("The plan is ready."));
	const faux = fauxProvider({ provider: "background-recovery-test", models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 1000 }] });
	const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [background] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: faux.getModel(), settingsManager, resourceLoader, sessionManager: SessionManager.open(manager.getSessionFile()!), noTools: "all" });
	try {
		await session.bindExtensions({ mode: "rpc" });
		expect(faux.state.callCount).toBe(0);
		const saved = session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "background");
		expect(saved).toHaveLength(1);
		expect(recoverJobs(session.sessionManager.getBranch(), manager.getSessionId())[0].job.notified).toBe(true);
	} finally { session.dispose(); }
});

function run(stage: string, cwd: string, file = ""): Promise<{ output: string; file: string; code: number | null; signal: string | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["test/fixtures/background-restart.ts", stage, cwd, file], {
			cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		if (!child.stdout || !child.stderr) { child.kill(); reject(new Error("Missing fixture output pipes")); return; }
		let output = "";
		let sessionFile = file;
		child.stdout.on("data", (data) => { output += data.toString(); });
		child.stderr.on("data", (data) => { output += data.toString(); });
		child.on("message", (message) => { sessionFile = (message as { file: string }).file; });
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ output, file: sessionFile, code, signal }));
	});
}

describe.runIf(realBashAvailable())("live recovery boundaries", () => {
	it("fences late callbacks when a tree move restores unfinished work", async () => {
		const pi = createFakePi(); background(pi.api);
		await pi.emit({ type: "session_start" });
		await inspect(pi, "background_bash", { command: "sleep 1; echo old", what: "old branch" });
		const branch = pi.entries.map((entry) => ({ type: "custom", ...entry }));
		await pi.emit({ type: "session_tree", oldLeafId: "old", newLeafId: "new" }, { branch });
		expect(await inspect(pi, "background_result", { id: "bg-1" })).toContain("unconfirmed");
		await inspect(pi, "background_bash", { command: "sleep 0.1; echo new", what: "new branch" });
		await untilNotices(pi, 2);
		expect(pi.messages.map((notice) => (notice.details as { status: string }).status)).toEqual(["unconfirmed", "done"]);
		expect(await inspect(pi, "background_result", { id: "bg-2" })).toContain("new");
		await pi.emit({ type: "session_shutdown" });
	});
	it("isolates forked sessions and reused short ids from old process callbacks", async () => {
		const pi = createFakePi(); background(pi.api);
		await pi.emit({ type: "session_start" }, { sessionId: "original" });
		await inspect(pi, "background_bash", { command: "sleep 1; echo original", what: "original job" });
		const copiedBranch = pi.entries.map((entry) => ({ type: "custom", ...entry }));
		await pi.emit({ type: "session_shutdown" }, { sessionId: "original" });
		await pi.emit({ type: "session_start" }, { sessionId: "fork", branch: copiedBranch });
		expect(await inspect(pi, "background_list")).toBe("No background jobs.");
		await inspect(pi, "background_bash", { command: "sleep 0.1; echo fork", what: "fork job" });
		await untilNotices(pi, 1);
		expect(pi.messages[0].content).toContain("fork job");
		expect(pi.messages[0].content).not.toContain("original job");
		await pi.emit({ type: "session_shutdown" }, { sessionId: "fork" });
	});
	it("refuses effects after a start-record failure and reports a terminal-record failure", async () => {
		const pi = createFakePi(); background(pi.api);
		await pi.emit({ type: "session_start" });
		const append = pi.api.appendEntry.bind(pi.api);
		pi.api.appendEntry = () => { throw new Error("disk full"); };
		expect(await inspect(pi, "background_bash", { command: "true", what: "must not run" })).toContain("command was NOT started");
		expect(await inspect(pi, "background_list")).toBe("No background jobs.");
		pi.api.appendEntry = (type, data) => {
			if ((data as { job: { status: string } }).job.status !== "running") throw new Error("disk full");
			append(type, data);
		};
		await inspect(pi, "background_bash", { command: "echo output", what: "unsaved result" });
		await untilNotices(pi, 1);
		expect(pi.messages[0].content).toContain("NOT saved for recovery: Error: disk full");
		expect(await inspect(pi, "background_result", { id: "bg-1" })).toContain("NOT saved for recovery");
		await pi.emit({ type: "session_shutdown" });
	});
});

describe.runIf(realBashAvailable())("real process crash and resume", () => {
	it.each(["record-before-notice", "notice-before-mark", "effect-before-record"])("recovers the %s boundary without repeating command effects", async (stage) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-background-recovery-"));
		directories.push(cwd);
		const crashed = await run(stage, cwd);
		expect(crashed.output).toBe("");
		expect(crashed.signal).toBe("SIGKILL");
		expect(crashed.file).toBeTruthy();
		const resumed = await run("read", cwd, crashed.file);
		expect(resumed.code, resumed.output).toBe(0);
		const restored = JSON.parse(resumed.output) as { result: string; notices: unknown[] };
		expect(restored.result).toContain(stage === "effect-before-record" ? "unconfirmed" : "done");
		if (stage !== "effect-before-record") expect(restored.result).toContain("retained-output");
		expect(restored.notices).toHaveLength(stage === "notice-before-mark" ? 0 : 1);
		const again = await run("read", cwd, crashed.file);
		expect(again.code, again.output).toBe(0);
		expect(JSON.parse(again.output).notices).toHaveLength(0);
		expect(await readFile(join(cwd, "effects"), "utf8")).toBe("effect\n");
	}, 15_000);
});
