/**
 * The pi behaviour hive-common/waker.ts is built on — pinned against the
 * installed runtime, because none of it is documented API.
 *
 * 1. A custom message sent while streaming with `triggerTurn` not `false` goes
 *    onto the agent's FOLLOW-UP queue, and the agent loop drains that queue at
 *    "Agent would stop here" — the run continues past the agent's final word.
 *    That is the mid-run "it kept going" path the waker exists to avoid.
 * 2. `triggerTurn: false` while streaming is parked in `_pendingCustomMessages`
 *    and appended at turn end, never continuing the run by itself.
 *
 * If a pi upgrade changes either, this fails and the waker must be re-read
 * before the bump lands.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULES = join(import.meta.dirname, "..", "node_modules", "@earendil-works");
const session = readFileSync(join(MODULES, "pi-coding-agent/dist/core/agent-session.js"), "utf8");
const loop = readFileSync(join(MODULES, "pi-agent-core/dist/agent-loop.js"), "utf8");

function sendCustomMessageBody(): string {
	const start = session.indexOf("async sendCustomMessage(");
	expect(start, "sendCustomMessage moved or was renamed").toBeGreaterThan(-1);
	return session.slice(start, session.indexOf("\n    }\n", start));
}

describe("pi follow-up semantics the waker relies on", () => {
	it("a streaming message that may trigger a turn joins the follow-up queue", () => {
		expect(sendCustomMessageBody()).toMatch(
			/this\.isStreaming && options\?\.triggerTurn !== false\)\s*\{\s*if \(options\?\.deliverAs === "followUp"\)\s*\{\s*this\.agent\.followUp\(appMessage\)/,
		);
	});

	it("a streaming message with triggerTurn:false is parked until turn end", () => {
		expect(sendCustomMessageBody()).toMatch(/else if \(this\.isStreaming\)\s*\{[\s\S]*?this\._pendingCustomMessages\.push\(appMessage\)/);
	});

	it("the agent loop drains follow-ups where the agent would otherwise stop", () => {
		expect(loop).toMatch(/Agent would stop here\. Check for follow-up messages\.\s*const followUpMessages = \(await config\.getFollowUpMessages\?\.\(\)\)/);
	});
});
