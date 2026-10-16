/** Owner-invoked bounded protocol. Uses real Pi messages, tools and settlement. */
import { randomBytes } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PilotQueryBudget } from "./pilot-budget.ts";
import { claimPilotAttempt } from "./pilot-latch.ts";
import type { LaunchConfig } from "./runtime.ts";

const DENIED = "Claude SDK pilot write denied";
const WRITE = "SDK_PILOT_WRITE_MUST_BE_BLOCKED";
type Stage = "authority" | "recall";
type Category = "none" | "configuration" | "protocol" | "deadline" | "cleanup" | "reporting";
export interface PilotReport {
	protocol: 1; status: "passed" | "failed"; category: Category;
	reserved_sdk_turns: number; observed_sdk_turns: number;
	tool_authority: "passed" | "not_verified"; history_recall: "passed" | "not_verified";
	query_cleanup: "passed" | "failed"; fixture_cleanup: "passed" | "failed";
	explicit_resets: number; http_attempts: "unmeasured"; report_publication_failures: number;
}
function text(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.flatMap(block => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}
function messages(ctx: ExtensionContext) {
	return ctx.sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []);
}
type Messages = ReturnType<typeof messages>;
interface Waiting {
	stage: Stage; prompt: string; session: string; leaf: string | null;
	before: Set<string>; started: boolean; ownedUser: boolean;
	resolve: (messages: Messages) => void; reject: () => void;
}

/** Registers restrictions, never a replacement/reduced tool or system prompt. */
export function registerPilot(pi: ExtensionAPI, config: LaunchConfig, budget: PilotQueryBudget,
	reset: () => Promise<void>, close: () => Promise<void>, deadlineMs = 180_000) {
	let attempted = false;
	let running = false;
	let waiting: Waiting | undefined;
	let context: ExtensionContext | undefined;
	let fixture = "";
	let ownsFixture = false;
	let nonce = "";
	let category: Category = "none";
	let done: Promise<void> = Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let blockedWrite: string | undefined;
	let authority = false;
	let recall = false;
	let resets = 0;
	let activeTools: string[] = [];
	let abortFailed = false;
	const abort = () => { try { context?.abort(); } catch { abortFailed = true; } };
	const fail = (reason: Category = "protocol") => {
		if (category === "none") category = reason;
		budget.close(); waiting?.reject(); abort();
	};
	const sameBranch = (ctx: ExtensionContext, owned: Waiting) => ctx.sessionManager.getSessionId() === owned.session &&
		(owned.leaf === null || ctx.sessionManager.getBranch().some(entry => entry.id === owned.leaf));

	pi.on("input", event => {
		if (running && event.text !== waiting?.prompt) { fail(); return { action: "handled" }; }
	});
	pi.on("session_before_compact", () => {
		// Never let Pi start a separate compaction inference during this pilot.
		if (running) fail();
		return { cancel: true };
	});
	pi.on("agent_start", (_event, ctx) => {
		const owned = waiting;
		if (!running || !owned || owned.started || !sameBranch(ctx, owned)) { if (running) fail(); return; }
		owned.started = true;
	});
	pi.on("message_end", event => {
		const owned = waiting;
		if (!running || !owned || event.message.role !== "user") return;
		if (owned.ownedUser || text(event.message) !== owned.prompt) { fail(); return; }
		owned.ownedUser = true;
	});
	pi.on("agent_settled", (_event, ctx) => {
		const owned = waiting;
		if (!owned || !owned.started || !owned.ownedUser || !sameBranch(ctx, owned)) { if (running) fail(); return; }
		if (!isDeepStrictEqual(pi.getActiveTools(), activeTools) || ctx.model?.provider !== "claude-sdk") { fail(); return; }
		const added = ctx.sessionManager.getBranch().filter(entry => !owned.before.has(entry.id))
			.flatMap(entry => entry.type === "message" ? [entry.message] : []);
		waiting = undefined;
		owned.resolve(added);
	});
	pi.on("tool_call", event => {
		if (!running || waiting?.stage !== "authority") return { block: true, reason: "Claude SDK pilot tool execution not authorized" };
		if (event.toolName === "read" && isDeepStrictEqual(event.input, { path: fixture })) return;
		if (event.toolName === "write" && isDeepStrictEqual(event.input, { path: fixture, content: WRITE })) {
			blockedWrite = event.toolCallId;
			return { block: true, reason: DENIED };
		}
		return { block: true, reason: "Claude SDK pilot unexpected tool denied" };
	});

	function dispatch(stage: Stage, prompt: string, ctx: ExtensionContext): Promise<Messages> {
		return new Promise((resolve, reject) => {
			if (waiting || category !== "none") { reject(new Error("Pilot protocol failed")); return; }
			waiting = { stage, prompt, session: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId(),
				before: new Set(ctx.sessionManager.getBranch().map(entry => entry.id)), started: false, ownedUser: false,
				resolve, reject: () => reject(new Error("Pilot protocol failed")) };
			// Void API. Completion comes ONLY from the correlated agent_settled.
			pi.sendUserMessage(prompt);
		});
	}
	function verifyAuthority(history: Messages): void {
		const users = history.filter(message => message.role === "user");
		const assistants = history.filter(message => message.role === "assistant");
		const results = history.filter(message => message.role === "toolResult");
		if (users.length !== 1 || assistants.length !== 2 || results.length !== 2 ||
			assistants[0].stopReason !== "toolUse" || assistants[1].stopReason !== "stop" ||
			text(assistants[1]).trim() !== "ACK") throw new Error("Pilot protocol failed");
		const calls = assistants[0].content.filter(block => block.type === "toolCall");
		if (calls.length !== 2 || new Set(calls.map(call => call.id)).size !== 2) throw new Error("Pilot protocol failed");
		for (const name of ["read", "write"]) {
			const call = calls.find(call => call.name === name);
			const result = results.find(result => result.toolCallId === call?.id && result.toolName === name);
			if (!call || !result || !isDeepStrictEqual(call.arguments, { path: fixture, ...(name === "write" ? { content: WRITE } : {}) }) ||
				(name === "read" ? result.isError || !text(result).includes(nonce) :
					!result.isError || call.id !== blockedWrite || !text(result).includes(DENIED))) throw new Error("Pilot protocol failed");
		}
	}
	async function run(ctx: ExtensionCommandContext): Promise<void> {
		try {
			budget.arm(["claude-7"]);
			const first = await dispatch("authority", [
				"Hive SDK pilot: in ONE tool batch call read with exactly {path: " + JSON.stringify(fixture) + "}",
				"and write with exactly {path: " + JSON.stringify(fixture) + ", content: " + JSON.stringify(WRITE) + "}.",
				"Use these two tools exactly once each, and no others. After their results, reply exactly ACK.",
			].join("\n"), ctx);
			// The correlated settlement is the completion barrier. Also wait for
			// its remaining listeners before dispatching a new prompt.
			await ctx.waitForIdle();
			verifyAuthority(first);
			if (await readFile(fixture, "utf8") !== nonce) throw new Error("Pilot protocol failed");
			authority = true;
			await reset(); resets++;
			budget.allowRecall();
			const second = await dispatch("recall",
				"From the earlier successful read result in this conversation, recall the fixture's exact contents. " +
				"Reply only with those contents. Do not call any tool.", ctx);
			await ctx.waitForIdle();
			const assistants = second.filter(message => message.role === "assistant");
			if (second.filter(message => message.role === "user").length !== 1 || assistants.length !== 1 ||
				assistants[0].stopReason !== "stop" || assistants[0].content.some(block => block.type === "toolCall") ||
				text(assistants[0]).trim() !== nonce || await readFile(fixture, "utf8") !== nonce ||
				budget.reservedTurns !== 3 || budget.observedTurns > 3) throw new Error("Pilot protocol failed");
			recall = true;
		} catch { fail(category === "none" ? "protocol" : category); }
		finally { await finish(); }
	}
	async function finish(): Promise<void> {
		clearTimeout(timer); budget.close(); abort();
		let cleanup = !abortFailed;
		let fixtureCleanup = true;
		if (abortFailed) category = "cleanup";
		try { await close(); } catch { cleanup = false; category = "cleanup"; }
		try { if (ownsFixture) { await unlink(fixture); ownsFixture = false; } } catch { fixtureCleanup = false; category = "cleanup"; }
		const report: PilotReport = { protocol: 1, status: authority && recall && cleanup && fixtureCleanup && category === "none" ? "passed" : "failed",
			category, reserved_sdk_turns: budget.reservedTurns, observed_sdk_turns: budget.observedTurns,
			tool_authority: authority ? "passed" : "not_verified", history_recall: recall ? "passed" : "not_verified",
			query_cleanup: cleanup ? "passed" : "failed", fixture_cleanup: fixtureCleanup ? "passed" : "failed",
			explicit_resets: resets, http_attempts: "unmeasured", report_publication_failures: 0 };
		// Fixed statuses/counts only: never persist errors, nonce, account or SDK payloads here.
		const publicationFailed = () => { report.status = "failed"; report.category = "reporting"; report.report_publication_failures++; };
		try { await writeFile(join(config.stateRoot, "pilot-result.json"), JSON.stringify(report) + "\n", { mode: 0o600, flag: "wx" }); }
		catch { publicationFailed(); }
		running = false;
		// Each channel is independent: a failed artifact must not suppress the
		// canonical entry, displayed status or event. Later channels observe
		// earlier publication failures; this is not an atomic multi-channel commit.
		for (const publish of [
			() => pi.appendEntry("claude-sdk-pilot-result", report),
			() => pi.sendMessage({ customType: "claude-sdk-pilot-result", content: JSON.stringify(report), display: true }, { triggerTurn: false }),
			() => pi.events.emit("hive.claude-sdk-pilot.result", report),
		]) { try { publish(); } catch { publicationFailed(); } }
	}
	pi.registerCommand("claude-sdk-pilot", {
		description: "One launch-private, bounded SDK authority/history pilot (three SDK turns, no rerun)",
		handler: async (args, ctx) => {
			if (attempted) throw new Error("Claude SDK pilot attempt already consumed");
			attempted = true; running = true; context = ctx;
			let releaseSetup!: () => void;
			const setup = new Promise<void>(resolve => { releaseSetup = resolve; });
			let work = Promise.resolve();
			// Shutdown owns the whole command setup, not only the scheduled run.
			// The command itself still returns before its nested prompt starts.
			done = setup.then(() => work);
			void done.catch(() => { fail("cleanup"); running = false; });
			let claimed = false;
			try {
				await claimPilotAttempt(config);
				claimed = true;
				if (category !== "none") throw new Error("Pilot configuration refused");
				if (args.trim() !== "--exclude claude-7" || ctx.model?.provider !== "claude-sdk" || !ctx.isIdle() || ctx.hasPendingMessages() ||
					messages(ctx).some(message => message.role === "user" || message.role === "assistant" || message.role === "toolResult"))
					throw new Error("Pilot configuration refused");
				activeTools = pi.getActiveTools();
				if (!activeTools.includes("read") || !activeTools.includes("write")) throw new Error("Pilot configuration refused");
				nonce = randomBytes(24).toString("hex");
				fixture = join(config.stateRoot, "pilot-fixture.txt");
				const file = await open(fixture, "wx", 0o600);
				ownsFixture = true;
				try { await file.writeFile(nonce); } finally { await file.close(); }
				if (category !== "none") throw new Error("Pilot configuration refused");
				pi.setThinkingLevel("off");
				timer = setTimeout(() => fail("deadline"), deadlineMs);
				// Return the slash command before entering another prompt; never await a nested prompt.
				work = new Promise<void>(resolve => setImmediate(resolve)).then(() => run(ctx));
			} catch {
				fail("configuration");
				// Only the latch owner may publish this attempt. A reload refusal
				// must not replace an earlier report or remove its fixture.
				if (claimed) await finish();
				running = false;
				throw new Error("Claude SDK pilot configuration refused; attempt consumed");
			} finally { releaseSetup(); }
		},
	});
	return { cancel: () => { if (running) fail(); }, done: () => done };
}
