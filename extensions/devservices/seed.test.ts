import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pgPaths, seedFromTemplate } from "./pg.ts";

// seedFromTemplate must NEVER throw: a seed is an optimisation, and the caller
// has already created a usable empty database by the time it runs. Every one of
// these is a failure that can really happen — a dead presign, an object store
// the sandbox cannot reach, a truncated body.
describe("seedFromTemplate fails open", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seedtest-"));
	const paths = pgPaths();

	it("reports an unreachable object store instead of throwing", async () => {
		const result = await seedFromTemplate(paths, 1, "app", "https://example.invalid/x.dump", dir, () => {
			throw new Error("getaddrinfo ENOTFOUND");
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("unreachable");
	});

	it("reports a non-200 (an expired presign is a 403)", async () => {
		const result = await seedFromTemplate(paths, 1, "app", "https://example.invalid/x.dump", dir, async () =>
			new Response("", { status: 403 }),
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("403");
	});

	it("reports an empty body rather than restoring nothing", async () => {
		const result = await seedFromTemplate(paths, 1, "app", "https://example.invalid/x.dump", dir, async () =>
			new Response(new ArrayBuffer(0), { status: 200 }),
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("empty");
	});

	it("leaves no dump behind on the failure path", async () => {
		const before = fs.readdirSync(dir).length;
		await seedFromTemplate(paths, 1, "app", "https://example.invalid/x.dump", dir, async () =>
			new Response("not a dump", { status: 200 }),
		);
		expect(fs.readdirSync(dir).length).toBe(before);
	});
});
