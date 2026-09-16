import { describe, expect, it } from "vitest";

import { metaModels } from "./provider.ts";

// Structured output for Muse rides on `compat.supportsStrictMode`: it turns on
// strict JSON-schema constrained tool inputs, which api.meta.ai was verified to
// accept (a /v1/responses call with a strict:true tool returned 200 + a correct
// schema-shaped call, 2026-09-16). These assertions pin the decision so a later
// edit to the entries cannot silently drop the capability — or, worse, add back
// the two flags that were deliberately left off.
describe("Muse model compat", () => {
	it("enables strict-mode structured output on every entry", () => {
		expect(metaModels.length).toBeGreaterThan(0);
		for (const m of metaModels) {
			expect(m.compat?.supportsStrictMode, `${m.id} must enable structured output`).toBe(true);
		}
	});

	// api.meta.ai returns HTTP 500 on the tool_search wire item, so enabling this
	// would break Muse whenever a tool defers. Keep it off until Meta supports it.
	it("leaves tool search OFF (Meta 500s on the tool_search item)", () => {
		for (const m of metaModels) {
			const c = (m.compat ?? {}) as Record<string, unknown>;
			expect(c.supportsToolSearch ?? false, `${m.id} must not enable tool search`).toBe(false);
			expect(c.supportsAdditionalTools ?? false, `${m.id} must not enable additional-tools`).toBe(false);
		}
	});
});
