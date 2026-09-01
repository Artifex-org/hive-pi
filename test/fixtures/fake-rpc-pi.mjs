#!/usr/bin/env node
// A stand-in for `pi --mode rpc` with the QUEUE semantics of pi 0.84.2, which
// is the property the durable worker's dispatch got wrong:
//
//   - `prompt` starts a turn (agent_start … turn_end … agent_settled);
//   - `steer` / `follow_up` on an IDLE agent are acknowledged with
//     `success:true`, emit `queue_update`, and start NOTHING — measured against
//     the real binary, and the reason every orchestrate worker sat at
//     "idle, 0 turn(s), 0 tokens" (see rpc-protocol.ts dispatchCommand).
//
// FAKE_RPC_PI_MODE=never-start acknowledges a prompt and then goes silent, so
// the start watchdog has something to catch.
//
// Every command it receives is echoed to stderr, so a test can assert on the
// wire shape the parent actually sent rather than on what it meant to send.
import { createInterface } from "node:readline";

const mode = process.env.FAKE_RPC_PI_MODE ?? "pi-0.84";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	process.stderr.write(`received ${JSON.stringify(command)}\n`);
	emit({ id: command.id, type: "response", command: command.type, success: true });

	if (command.type === "steer" || command.type === "follow_up") {
		// Queue-only: nothing drains it on an idle agent.
		emit({ type: "queue_update", steering: command.type === "steer" ? [command.message] : [], followUp: command.type === "follow_up" ? [command.message] : [] });
		return;
	}
	if (command.type !== "prompt") return;
	if (mode === "never-start") return;

	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `echo: ${command.message}` }],
			usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
		},
	});
	emit({ type: "turn_end" });
	emit({ type: "agent_end" });
	emit({ type: "agent_settled" });
});
