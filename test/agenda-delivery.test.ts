import { describe, expect, it, vi } from "vitest";
import { installDriver } from "../extensions/agenda/driver.ts";
import type { Policy } from "../extensions/agenda/policy.ts";
import { createFakePi } from "./fake-pi.ts";

const text = "The gate FAILED: pending warning";
const oldEntry = { type: "custom_message", customType: "agenda", content: text };
function fixture() {
	const pi = createFakePi(), delivered = vi.fn(async () => {});
	const policy: Policy = { name: "gate", decide: () => ({
		name: "gate", status: "", run: async () => ({ metric: { outcome: "fail", value: 1 }, inject: text, delivered }),
	}) };
	const driver = installDriver(pi.api, { policies: [policy] });
	return { pi, delivered, driver };
}
async function queued() {
	const state = fixture();
	await state.pi.emit({ type: "session_start" });
	state.driver.pump();
	const end = Date.now() + 1_000;
	while (!state.pi.messages.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
	expect(state.pi.messages).toHaveLength(1);
	return { ...state, entry: { type: "custom_message", ...state.pi.messages[0] } };
}

describe("agenda notice delivery at actual host boundaries", () => {
	it("does not acknowledge a draft; acknowledges its later committed entry", async () => {
		const { pi, delivered } = fixture();
		pi.api.on("agent_before_settle", () => { expect(delivered).not.toHaveBeenCalled(); });
		const draft = await pi.emit({ type: "agent_before_settle" });
		expect(draft).toContainEqual(expect.objectContaining({ continue: true }));
		expect(delivered).toHaveBeenCalledTimes(1); // host committed, then emitted agent_start
	});

	it("does not acknowledge a discarded draft or mistake an older identical entry for delivery", async () => {
		const { pi, delivered } = fixture();
		let discard = true;
		pi.api.on("agent_before_settle", () => discard ? { entries: [], continue: false } : undefined);
		await pi.emit({ type: "agent_before_settle" }, { entries: [oldEntry], branch: [oldEntry] });
		await pi.emit({ type: "agent_settled" }, { entries: [oldEntry], branch: [oldEntry] });
		await pi.emit({ type: "agent_start" }, { entries: [oldEntry], branch: [oldEntry] });
		expect(delivered).not.toHaveBeenCalled();
		discard = false;
		await pi.emit({ type: "agent_before_settle" }, { entries: [oldEntry], branch: [oldEntry] });
		expect(delivered).toHaveBeenCalledTimes(1);
	});

	it("retains recovery eligibility when the session disappears before accepting a draft", async () => {
		const { pi, delivered } = fixture();
		pi.api.on("agent_before_settle", () => { throw new Error("host died before accepting continuation"); });
		await expect(pi.emit({ type: "agent_before_settle" })).rejects.toThrow("host died");
		await pi.emit({ type: "session_start" });
		await pi.emit({ type: "turn_start" }, { branch: [oldEntry] });
		expect(delivered).not.toHaveBeenCalled();
	});

	it("also waits for a committed entry after sendMessage accepts a queued follow-up", async () => {
		const { pi, delivered, entry } = await queued();
		expect(delivered).not.toHaveBeenCalled();
		await pi.emit({ type: "agent_start" }, { branch: [entry] });
		expect(delivered).toHaveBeenCalledTimes(1);
	});

	it("retains tracking through early notifications before the queue is persisted", async () => {
		const { pi, delivered, entry } = await queued();
		await pi.emit({ type: "agent_start" });
		expect(delivered).not.toHaveBeenCalled();
		await pi.emit({ type: "turn_start" }, { branch: [entry] });
		expect(delivered).toHaveBeenCalledTimes(1);
	});

	it("does not acknowledge an entry visible only on an abandoned branch", async () => {
		const { pi, delivered, entry } = await queued();
		await pi.emit({ type: "agent_start" }, { entries: [entry], branch: [] });
		expect(delivered).not.toHaveBeenCalled();
		await pi.emit({ type: "turn_start" }, { entries: [entry], branch: [entry] });
		expect(delivered).toHaveBeenCalledTimes(1);
	});
});
