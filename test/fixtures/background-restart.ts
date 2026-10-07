import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import background from "../../extensions/background/index.ts";
import { JOB_RECORD } from "../../extensions/background/journal.ts";
import { createFakePi } from "../fake-pi.ts";

// Separate OS processes use the actual Pi JSONL writer/reader. The facade only
// replaces model/UI calls; it does not implement or simulate disk persistence.
const [stage, cwd, file] = process.argv.slice(2);
const manager = stage.startsWith("read") ? SessionManager.open(file) : SessionManager.create(cwd, cwd);
if (!stage.startsWith("read")) manager.appendMessage({ role: "user", content: "Run a background check", timestamp: Date.now() });
const pi = createFakePi();
const append = pi.api.appendEntry.bind(pi.api);
pi.api.appendEntry = (customType, data) => {
	const terminal = customType === JOB_RECORD && (data as { job: { status: string } }).job.status !== "running";
	// Command effects have succeeded, but the terminal checkpoint does not exist.
	if (terminal && stage === "effect-before-record") process.kill(process.pid, "SIGKILL");
	manager.appendCustomEntry(customType, data);
	append(customType, data);
	if (terminal && stage === "record-before-notice") process.kill(process.pid, "SIGKILL");
};
const send = pi.api.sendMessage.bind(pi.api);
pi.api.sendMessage = (notice, options) => {
	manager.appendCustomMessageEntry(notice.customType, notice.content, notice.display ?? true, notice.details);
	send(notice, options);
	if (stage === "notice-before-mark") process.kill(process.pid, "SIGKILL");
};
background(pi.api);
await pi.emit({ type: "session_start" }, { mode: "rpc", cwd, sessionId: manager.getSessionId(), branch: manager.getBranch() });

async function call(name: string, params: Record<string, unknown>) {
	const tool = pi.tools.find((entry) => entry.name === name)!;
	const execute = (tool.definition as { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }).execute;
	return (await execute("id", params, undefined, undefined, { mode: "rpc", cwd })).content[0].text;
}
if (stage.startsWith("read")) {
	const result = await call("background_result", { id: "bg-1" });
	console.log(JSON.stringify({ result, notices: pi.messages, sessionId: manager.getSessionId() }));
	await pi.emit({ type: "session_shutdown" });
} else {
	process.send?.({ file: manager.getSessionFile() });
	await call("background_bash", {
		command: `printf 'effect\\n' >> ${JSON.stringify(join(cwd, "effects"))}; printf 'retained-output\\n'`,
		what: "restart boundary check",
	});
	// A missing callback should fail deterministically, not leave an orphan.
	setTimeout(() => { console.error("boundary was not reached"); process.exit(2); }, 5000);
}
