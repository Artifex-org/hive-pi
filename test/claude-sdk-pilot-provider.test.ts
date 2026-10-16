import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PilotQueryBudget } from "../extensions/claude-sdk/pilot-budget.ts";
import { createClaudeSdkRuntime, type QueryFactory } from "../extensions/claude-sdk/provider.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()));
	for (const result of results) expect(result.status).toBe("fulfilled");
});
const context = () => normalizeContext({ systemPrompt: "Unchanged Pi-owned test prompt", tools: [],
	messages: [{ role: "user", content: "offline fixture", timestamp: 1 }] });
const account = (name = "allowed") => ({ credential: name, slot: `${name}-slot`, access_token: "synthetic-only",
	expires_at: new Date(Date.now() + 3_600_000).toISOString() });

async function fixture(pilot = new PilotQueryBudget(), identity = account(), failFactory = false, httpLease = false) {
	const root = await mkdtemp(join(tmpdir(), "sdk-pilot-policy-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const lease = vi.fn(async () => identity);
	const requests: Options[] = [];
	const query: QueryFactory = request => {
		requests.push(request.options);
		if (failFactory) throw new Error("synthetic post-start failure");
		const iterator = (async function* () {
			await request.prompt[Symbol.asyncIterator]().next();
			yield { type: "assistant", parent_tool_use_id: null,
				message: { id: "fixture-response", content: [{ type: "text", text: "fixture" }], stop_reason: "end_turn", usage: {} } } as SDKMessage;
			yield { type: "result", subtype: "success", is_error: false, num_turns: 1 } as SDKMessage;
		})();
		return { [Symbol.asyncIterator]: () => iterator, close: vi.fn() };
	};
	const runtime = createClaudeSdkRuntime({ executable: "/fake/pinned-cli", stateRoot: root, cwd: root,
		url: "https://hive.invalid", token: "synthetic", launch: "offline-only" },
	{ pilot, query, lease: httpLease ? undefined : lease, validateExecutable: async () => {} });
	cleanups.push(runtime.close);
	const model = runtime.provider.getModels()[0];
	const run = () => runtime.provider.streamSimple(model, context()).result();
	return { ...runtime, root, pilot, requests, lease, run };
}

describe("offline provider pilot enforcement (not native HTTP retry proof)", () => {
	it("sends separate exclusion parameters before the lease endpoint can select an account, across rebuilds", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(account()));
		vi.stubGlobal("fetch", fetcher);
		const budget = new PilotQueryBudget();
		budget.arm(["claude-7", "second-slot"]);
		const exposed = budget.excludedAccounts as string[];
		exposed.push("not-authorized-by-policy");
		const first = await fixture(budget, account(), false, true);
		expect((await first.run()).stopReason).toBe("stop");
		await first.close(); budget.allowRecall();
		const second = await fixture(budget, account(), false, true);
		expect((await second.run()).stopReason).toBe("stop");
		expect(fetcher).toHaveBeenCalledTimes(2);
		for (const [input, init] of fetcher.mock.calls) {
			const url = new URL(String(input));
			expect(url.searchParams.getAll("exclude")).toEqual(["claude-7", "second-slot"]);
			expect(url.pathname).toBe("/api/v1/agent-launches/offline-only/claude-auth");
			expect(init).toMatchObject({ method: "GET", redirect: "error" });
		}
	});

	it("refuses an ungranted new query after the first result before acquiring another lease", async () => {
		const budget = new PilotQueryBudget(); budget.arm([]);
		const first = await fixture(budget);
		expect((await first.run()).stopReason).toBe("stop");
		await first.close();
		const second = await fixture(budget);
		expect((await second.run()).errorMessage).toBe("claude_sdk_pilot_unexpected_query");
		expect(second.lease).not.toHaveBeenCalled();
		expect(second.requests).toEqual([]);
		expect(await readdir(second.root)).toEqual([]);
	});

	it("blocks an unknown opening command before even acquiring a lease", async () => {
		const f = await fixture();
		const output = await f.run();
		expect(output).toMatchObject({ stopReason: "error", errorMessage: "claude_sdk_pilot_not_armed" });
		expect(f.lease).not.toHaveBeenCalled();
		expect(f.requests).toEqual([]);
		expect(await readdir(f.root)).toEqual([]);
	});

	it("sets nonrefundable native query allowances across runtime rebuilds and refuses an extra request before leasing", async () => {
		const budget = new PilotQueryBudget();
		budget.arm(["excluded"]);
		const first = await fixture(budget);
		expect((await first.run()).stopReason).toBe("stop");
		expect(first.requests[0]).toMatchObject({ maxTurns: 2 });
		expect(first.requests[0].env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("512");
		await first.close();
		budget.allowRecall();
		const second = await fixture(budget);
		expect((await second.run()).stopReason).toBe("stop");
		expect(second.requests[0]).toMatchObject({ maxTurns: 1 });
		expect(budget.reservedTurns).toBe(3);
		expect(budget.observedTurns).toBe(2);
		expect((await second.run()).stopReason).toBe("error");
		expect(second.requests).toHaveLength(1);
		expect(second.lease).toHaveBeenCalledTimes(1);
	});

	it.each(["credential", "slot"] as const)("rejects an excluded %s before query construction", async key => {
		const budget = new PilotQueryBudget();
		const identity = { ...account(), [key]: "excluded" };
		budget.arm(["excluded"]);
		const f = await fixture(budget, identity);
		expect((await f.run()).errorMessage).toBe("claude_sdk_pilot_account_excluded");
		expect(f.requests).toEqual([]);
		expect(budget.reservedTurns).toBe(0);
	});

	it("cannot switch accounts for the canonical-history rebuild", async () => {
		const budget = new PilotQueryBudget();
		budget.arm([]);
		const first = await fixture(budget);
		await first.run(); await first.close(); budget.allowRecall();
		const second = await fixture(budget, account("other"));
		expect((await second.run()).errorMessage).toBe("claude_sdk_pilot_account_changed");
		expect(second.requests).toEqual([]);
		expect(budget.reservedTurns).toBe(2);
	});

	it("never refunds a factory failure or retries it through a fresh runtime", async () => {
		const budget = new PilotQueryBudget();
		budget.arm([]);
		const first = await fixture(budget, account(), true);
		expect((await first.run()).stopReason).toBe("error");
		expect(first.requests).toHaveLength(1);
		await first.close();
		const second = await fixture(budget);
		expect((await second.run()).stopReason).toBe("error");
		expect(second.requests).toEqual([]);
		expect(budget.reservedTurns).toBe(2);
	});
});
