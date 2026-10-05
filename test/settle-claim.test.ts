/**
 * At most one automatic turn per settle, across injectors (pi 0.87+).
 *
 * pi now DEFERS a triggerTurn sent from `agent_settled` until every handler
 * has returned, so `ctx.isIdle()` reads true for the whole chain and stopped
 * separating injectors: the agenda driver and plan auto-continue both
 * injected on one settle. These tests pin the settle claim that replaced it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installDriver } from "../extensions/agenda/driver.ts";
import type { Policy, PolicyWork } from "../extensions/agenda/policy.ts";
import { createAutoContinueState, runAutoContinue } from "../extensions/plan/autocontinue.ts";
import { applyOps, emptyPlan, PLAN_ENTRY_TYPE, toEntry } from "../extensions/plan/state.ts";
import planExtension from "../extensions/plan/index.ts";
import { AUTOCONTINUE_MESSAGE_TYPE } from "../extensions/plan/autocontinue.ts";
import { trackSettleClaims } from "../extensions/hive-common/settle-claim.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

function injects(text: string): Policy {
	return {
		name: text,
		decide: (): PolicyWork => ({
			name: text,
			status: "",
			run: async () => ({ metric: { outcome: "fail", value: 1 }, inject: text }),
		}),
	};
}

let pi: FakePi;
beforeEach(() => {
	pi = createFakePi();
});

describe("two injectors on one settle", () => {
	it.each([true, false])("agenda and the actual plan extension continue exactly once (plan first=%s)", async planFirst => {
		const doc = applyOps(emptyPlan(0), [
			{ op: "lane", kind: "execute", title: "Execute", items: [{ id: "next", title: "Next", status: "pending" }] },
			{ op: "header", phase: "approved" },
		], 1).doc;
		if (planFirst) planExtension(pi.api);
		installDriver(pi.api, { policies: [injects("agenda next")] });
		if (!planFirst) planExtension(pi.api);
		const context = { idle: false, branch: [{ customType: PLAN_ENTRY_TYPE, data: toEntry(doc) }] };
		await pi.emit({ type: "session_start", reason: "startup" }, context);
		await pi.emit({ type: "agent_before_settle" }, context);
		expect(pi.messages).toHaveLength(1);
		expect(pi.messages[0].customType).toBe(planFirst ? AUTOCONTINUE_MESSAGE_TYPE : "agenda");
	});

	it("only the first injects; the session stays idle throughout, at the native boundary", async () => {
		installDriver(pi.api, { policies: [injects("first")] });
		installDriver(pi.api, { policies: [injects("second")] });

		await pi.emit({ type: "agent_before_settle" });

		expect(pi.messages.map((m) => m.content)).toEqual(["first"]);
	});

	it("the claim clears when the claimed turn starts, so the next settle is served", async () => {
		installDriver(pi.api, { policies: [injects("first")] });
		installDriver(pi.api, { policies: [injects("second")] });

		await pi.emit({ type: "agent_before_settle" });
		await pi.emit({ type: "agent_before_settle" });

		expect(pi.messages.map((m) => m.content)).toEqual(["first", "first"]);
	});
});

describe("plan auto-continue", () => {
	it("stands down when another injector already took the settle", () => {
		const claims = trackSettleClaims(pi.api);
		claims.claim("agenda");
		const ctx = {
			mode: "tui",
			isIdle: () => true,
			hasPendingMessages: () => false,
			sessionManager: { getBranch: () => [] },
		} as unknown as ExtensionContext;

		const decision = runAutoContinue(pi.api, ctx, {
			loadDoc: () => emptyPlan(0),
			state: createAutoContinueState(),
			uiPromptOpen: false,
			settleClaims: claims,
			env: {},
		});

		expect(decision).toMatchObject({ action: "noop", reason: "settle already taken by agenda" });
		expect(pi.messages).toHaveLength(0);
	});
});
