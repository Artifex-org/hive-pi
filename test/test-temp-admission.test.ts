import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRun, registerReader } from "../scripts/test-temp.ts";

const dirs: string[] = [];
const token = "11111111-1111-4111-8111-111111111111";
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scopes() {
	const base = mkdtempSync(join(tmpdir(), "a-")); dirs.push(base);
	const outer = createRun(join(base, "runs"), token);
	const inner = createRun(join(outer.path, "tmp", "runs"), token);
	return { outer, inner };
}
const leases = (path: string) => readdirSync(join(path, "readers")).sort();
it("rolls back only this admission, preserving existing ancestor leases", () => {
	const { outer, inner } = scopes();
	registerReader(outer.path);
	const before = leases(outer.path);
	writeFileSync(join(inner.path, "closing"), "claimed");
	if (process.platform === "linux") expect(() => registerReader(inner.path)).toThrow(/closing/);
	else registerReader(inner.path);
	expect(leases(outer.path)).toEqual(before);
	expect(leases(inner.path)).toEqual([]);
});
it("rejects inner admission when an enclosing scope is closing", () => {
	const { outer, inner } = scopes();
	const before = leases(outer.path);
	writeFileSync(join(outer.path, "closing"), "claimed");
	if (process.platform === "linux") expect(() => registerReader(inner.path)).toThrow(/closing/);
	else registerReader(inner.path);
	expect(leases(outer.path)).toEqual(before);
	expect(leases(inner.path)).toEqual([]);
});
it("admits bootstrap before creating nested directories or starting a runner", () => {
	const { outer } = scopes();
	const before = leases(outer.path);
	const root = join(outer.path, "uncreated");
	writeFileSync(join(outer.path, "closing"), "claimed");
	if (process.platform === "linux") {
		expect(() => createRun(root, token)).toThrow(/closing/);
		expect(existsSync(root)).toBe(false);
	} else createRun(root, token);
	expect(leases(outer.path)).toEqual(before);
});
it("refuses an inner reader beneath an already claimed parent run", () => {
	const { outer, inner } = scopes();
	writeFileSync(join(outer.path, "closing"), "claimed");
	const claimed = join(dirname(outer.path), "reap-fixture");
	renameSync(outer.path, claimed);
	const moved = join(claimed, "tmp", "runs", basename(inner.path));
	if (process.platform === "linux") expect(() => registerReader(moved)).toThrow(/closing/);
	else registerReader(moved);
	expect(leases(moved)).toEqual([]);
});
it("refuses malformed managed ancestry rather than admitting an unprotected reader", () => {
	const { outer, inner } = scopes();
	writeFileSync(join(outer.path, "owner.json"), "{");
	if (process.platform === "linux") expect(() => registerReader(inner.path)).toThrow();
	else registerReader(inner.path);
	expect(leases(inner.path)).toEqual([]);
});
it("does not publish namespace-local PID identities into a different identity domain", () => {
	const { outer, inner } = scopes();
	const before = leases(outer.path);
	if (outer.owner.domain) outer.owner.domain.namespace = "different";
	writeFileSync(join(outer.path, "owner.json"), JSON.stringify(outer.owner));
	if (process.platform === "linux") expect(() => registerReader(inner.path)).toThrow(/identity domain/);
	else registerReader(inner.path);
	expect(leases(outer.path)).toEqual(before);
	expect(leases(inner.path)).toEqual([]);
});
