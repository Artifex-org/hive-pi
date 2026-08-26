import http2 from "node:http2";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeFrame } from "./protocol.ts";
import { runTurn } from "./transport.ts";

// The first test of this extension's SOCKET path, and the reason it exists:
// both serious defects here lived in that path and neither was reachable by a
// unit test. The predicate tests in idle.test.ts prove `isHeartbeatOnly`
// classifies a frame correctly; only this proves the classification is actually
// WIRED to the timer that ends the turn.
//
// A heartbeating server reproduces the measured failure exactly: 40 minutes
// past the context pack, silence budget armed, never fired, because a heartbeat
// reset it every few seconds.

let server: http2.Http2Server | null = null;
const sessions = new Set<http2.ServerHttp2Session>();
const proxyEnvKeys = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
const cursorEnvKeys = ["CURSOR_API_URL", "CURSOR_TURN_STALL_MS", "CURSOR_STREAM_IDLE_MS"] as const;
const inheritedEnv = new Map([...proxyEnvKeys, ...cursorEnvKeys].map((key) => [key, process.env[key]]));

function clearProxyEnv(): void {
	for (const key of proxyEnvKeys) delete process.env[key];
}

beforeEach(clearProxyEnv);
afterEach(async () => {
	for (const session of sessions) session.destroy();
	sessions.clear();
	if (server) {
		await new Promise<void>((r) => server?.close(() => r()));
		server = null;
	}
	delete process.env.CURSOR_API_URL;
	delete process.env.CURSOR_TURN_STALL_MS;
	delete process.env.CURSOR_STREAM_IDLE_MS;
	clearProxyEnv();
});
afterAll(() => {
	for (const [key, value] of inheritedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** A server that accepts the run and then says only "still here", forever. */
async function heartbeatOnlyServer(): Promise<number> {
	server = http2.createServer();
	server.on("session", (session) => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream) => {
		stream.respond({ ":status": 200, "content-type": "application/connect+json" });
		const beat = setInterval(() => {
			// `close` and the next timer tick can race; never write a frame after
			// the client ended its stream, or server.close() will wait forever.
			if (stream.closed || stream.destroyed || !stream.writable) {
				clearInterval(beat);
				return;
			}
			stream.write(Buffer.from(encodeFrame({ interactionUpdate: { heartbeat: {} } })));
		}, 20);
		stream.on("close", () => clearInterval(beat));
		stream.on("error", () => clearInterval(beat));
	});
	return await new Promise<number>((resolve) => {
		server?.listen(0, "127.0.0.1", () => {
			resolve((server?.address() as { port: number }).port);
		});
	});
}

describe("a stream that heartbeats but never produces", () => {
	it("ends the turn instead of hanging on it", async () => {
		const port = await heartbeatOnlyServer();
		process.env.CURSOR_API_URL = `http://127.0.0.1:${port}`;
		// The progress budget must be the one that fires, so give SILENCE a budget
		// it cannot reach. If the silence timer ended this turn the test would
		// pass for the wrong reason — and would have passed before the fix.
		process.env.CURSOR_TURN_STALL_MS = "400";
		process.env.CURSOR_STREAM_IDLE_MS = "60000";

		const errors: string[] = [];
		await runTurn({
			accessToken: "t",
			modelId: "composer-2.5",
			systemPrompt: "sys",
			userText: "hi",
			workspacePath: "/tmp",
			events: {
				onText: () => {},
				onThinking: () => {},
				onDone: (_usage, error) => {
					if (error) errors.push(error);
				},
			},
		});

		expect(errors.join(" ")).toMatch(/produced nothing/);
		// Named so a future reader can tell the two budgets apart in a log.
		expect(errors.join(" ")).not.toMatch(/sent nothing/);
	}, 15_000);
});
