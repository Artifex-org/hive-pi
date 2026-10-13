import { afterEach, describe, expect, it } from "vitest";
import agenda from "../extensions/agenda/index.ts";
import { shouldAutoShutdown } from "../extensions/agenda/auto-shutdown.ts";
import { resolveEndOutcome } from "../extensions/hive-telemetry/accumulator.ts";
import { OPERATOR_INPUT_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi } from "./fake-pi.ts";

const originalOptIn = process.env.PI_AGENDA_AUTO_SHUTDOWN;
const originalHiveLaunchId = process.env.HIVE_LAUNCH_ID;

function doneConductor() {
	return {
		customType: "agenda",
		data: {
			kind: "conductor",
			schemaVersion: 1,
			id: "c1",
			stage: "done",
			complexity: "complex",
			createdAt: 1,
			updatedAt: 2,
		},
	};
}

afterEach(() => {
	if (originalOptIn === undefined) delete process.env.PI_AGENDA_AUTO_SHUTDOWN;
	else process.env.PI_AGENDA_AUTO_SHUTDOWN = originalOptIn;
	if (originalHiveLaunchId === undefined) delete process.env.HIVE_LAUNCH_ID;
	else process.env.HIVE_LAUNCH_ID = originalHiveLaunchId;
});

describe("shouldAutoShutdown", () => {
	const base = { enabled: true, mode: "rpc", unattendedHiveLaunch: false, attended: false, conductorDone: true, asksQuestion: false };

	it("requires explicit opt-in", () => {
		expect(shouldAutoShutdown({ ...base, enabled: false })).toBe(false);
	});

	it("only closes rpc sessions or Hive-marked unattended launches", () => {
		expect(shouldAutoShutdown({ ...base, mode: "tui" })).toBe(false);
		expect(shouldAutoShutdown({ ...base, mode: "tui", unattendedHiveLaunch: true })).toBe(true);
		expect(shouldAutoShutdown({ ...base, mode: "prompt" })).toBe(false);
	});

	it("waits for the conductor's post-consolidation terminal state", () => {
		expect(shouldAutoShutdown({ ...base, conductorDone: false })).toBe(false);
	});

	it("never closes while the assistant needs an operator", () => {
		expect(shouldAutoShutdown({ ...base, asksQuestion: true })).toBe(false);
	});

	it("accepts the fully verified unattended completion", () => {
		expect(shouldAutoShutdown(base)).toBe(true);
	});

	it("never closes a launch a person is steering", () => {
		expect(shouldAutoShutdown({ ...base, attended: true })).toBe(false);
		expect(shouldAutoShutdown({ ...base, mode: "tui", unattendedHiveLaunch: true, attended: true })).toBe(false);
	});
});

describe("graceful auto-shutdown observer", () => {
	it("calls ctx.shutdown for opted-in rpc completion and remains resumable", async () => {
		process.env.PI_AGENDA_AUTO_SHUTDOWN = "1";
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, { mode: "rpc", branch: [doneConductor()] });
		await fake.emit(
			{ type: "agent_settled" },
			{
				mode: "rpc",
				branch: [
					{ message: { role: "user", content: "finish" } },
					{ message: { role: "assistant", content: "Finished the verified work." } },
				],
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fake.shutdowns).toBe(1);
	});

	it("closes an HIVE_LAUNCH_ID-marked TUI session after conductor completion", async () => {
		process.env.PI_AGENDA_AUTO_SHUTDOWN = "1";
		process.env.HIVE_LAUNCH_ID = "launch-1";
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, { mode: "tui", branch: [doneConductor()] });
		await fake.emit({ type: "agent_settled" }, { mode: "tui", branch: [{ message: { role: "assistant", content: "done" } }] });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fake.shutdowns).toBe(1);
	});

	it("does not close a human TUI session", async () => {
		process.env.PI_AGENDA_AUTO_SHUTDOWN = "1";
		delete process.env.HIVE_LAUNCH_ID;
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, { mode: "tui", branch: [doneConductor()] });
		await fake.emit({ type: "agent_settled" }, { mode: "tui", branch: [{ message: { role: "assistant", content: "done" } }] });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fake.shutdowns).toBe(0);
	});

	it("does not close an unattended session awaiting an operator question", async () => {
		process.env.PI_AGENDA_AUTO_SHUTDOWN = "1";
		process.env.HIVE_LAUNCH_ID = "launch-1";
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, { mode: "tui", branch: [doneConductor()] });
		await fake.emit(
			{ type: "agent_settled" },
			{ mode: "tui", branch: [{ message: { role: "assistant", content: "Should I apply this change?" } }] },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fake.shutdowns).toBe(0);
	});

	it("does not close an unattended session with a pending operator approval", async () => {
		process.env.PI_AGENDA_AUTO_SHUTDOWN = "1";
		process.env.HIVE_LAUNCH_ID = "launch-1";
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, { mode: "tui", branch: [doneConductor()] });
		await fake.emit(
			{ type: "agent_settled" },
			{ mode: "tui", pendingMessages: true, branch: [{ message: { role: "assistant", content: "done" } }] },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fake.shutdowns).toBe(0);
	});

	// f2ead622 (2026-10-13): the operator typed into a launched session, it
	// consolidated, closed four minutes later, and their next two messages sat
	// unclaimed. A person-sent message makes the launch attended for good.
	it("does not close a Hive launch an operator has typed into", async () => {
		process.env.PI_AGENDA_AUTO_SHUTDOWN = "1";
		process.env.HIVE_LAUNCH_ID = "launch-1";
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, { mode: "tui", branch: [doneConductor()] });
		fake.api.events.emit(OPERATOR_INPUT_CHANNEL, { source: "operator" });
		await fake.emit({ type: "agent_settled" }, { mode: "tui", branch: [{ message: { role: "assistant", content: "done" } }] });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fake.shutdowns).toBe(0);
		expect(fake.entries.filter((e) => e.customType === "agenda-attended")).toHaveLength(1);
	});

	it("cancels a close already scheduled when the operator speaks before it runs", async () => {
		process.env.PI_AGENDA_AUTO_SHUTDOWN = "1";
		process.env.HIVE_LAUNCH_ID = "launch-1";
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, { mode: "tui", branch: [doneConductor()] });
		await fake.emit({ type: "agent_settled" }, { mode: "tui", branch: [{ message: { role: "assistant", content: "done" } }] });
		fake.api.events.emit(OPERATOR_INPUT_CHANNEL, { source: "driver" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fake.shutdowns).toBe(0);
	});

	it("stays attended across a resume — the flag is persisted, not process memory", async () => {
		process.env.PI_AGENDA_AUTO_SHUTDOWN = "1";
		process.env.HIVE_LAUNCH_ID = "launch-1";
		const fake = createFakePi();
		agenda(fake.api);
		const attended = { customType: "agenda-attended", data: { kind: "agenda-attended", at: 1, source: "operator" } };
		await fake.emit({ type: "session_start", reason: "resume" }, { mode: "tui", branch: [attended, doneConductor()] });
		await fake.emit({ type: "agent_settled" }, { mode: "tui", branch: [{ message: { role: "assistant", content: "done" } }] });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fake.shutdowns).toBe(0);
	});

	it("reports completed when the auto-close path shuts down with quit", async () => {
		process.env.PI_AGENDA_AUTO_SHUTDOWN = "1";
		process.env.HIVE_LAUNCH_ID = "launch-1";
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, { mode: "tui", branch: [doneConductor()] });
		await fake.emit({ type: "agent_settled" }, { mode: "tui", branch: [{ message: { role: "assistant", content: "done" } }] });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fake.shutdowns).toBe(1);
		expect(fake.shutdownReasons).toEqual(["quit"]);
		expect(resolveEndOutcome(undefined, fake.shutdownReasons[0])).toBe("completed");
	});
});
