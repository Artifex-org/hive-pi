import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import readiness from "../extensions/readiness/index.ts";
import { inspectRole } from "../extensions/readiness/roles.ts";
import { createFakePi } from "./fake-pi.ts";

const probes = vi.hoisted(() => ({ realDeps: vi.fn(), runAll: vi.fn() }));
vi.mock("../extensions/readiness/probes.ts", () => probes);
const mirror = vi.hoisted(() => vi.fn());
vi.mock("../extensions/mcp-common/config.ts", () => ({ ensureWorkerAgentDir: mirror }));
let root: string, cwd: string;
function role(dir: string, name: string, tools: string | null = "read, parent_only", alias = "inspect-alias") {
	mkdirSync(join(dir, "agents"), { recursive: true });
	writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\naliases: ${alias}\ndescription: inspection fixture\n${tools === null ? "" : `tools: ${tools}\n`}---\nPRIVATE ROLE PROMPT\n`);
}
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "role-inspection-")); cwd = join(root, "repo"); mkdirSync(cwd);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "user")); vi.stubEnv("PI_READINESS", "1");
	role(join(root, "user"), "inspect-fixture");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("readiness role inspection", () => {
	it("reports translated grants and provisioning, not worker or service readiness", () => {
		role(join(root, "user"), "inspect-fixture", "read, mcp, mcpScript, mcp__fixture__lookup");
		const report = inspectRole(cwd, "user", "inspect-fixture", true, ["read", "codemode"]);
		expect(report.translatedGrants).toEqual(["read", "codemode", "tool_search", "mcp__fixture__lookup"]);
		expect(report.parentRegistration.tools).toContainEqual({ name: "tool_search", status: "not_registered" });
		expect(report.worker).toMatchObject({ mcp: "configured", registration: "unknown", serviceHealth: "unknown" });
		expect(report.worker.builtinExtensions).toContain("builtin:mcp");
		expect(report).not.toHaveProperty("systemPrompt");
	});
	it("keeps empty/unreadable registry unknown and absent tools unrestricted", () => {
		for (const registry of [null, []]) {
			const report = inspectRole(cwd, "user", "inspect-fixture", true, registry);
			expect(report.parentRegistration.status).toBe("unknown");
			expect(report.parentRegistration.tools.every((tool) => tool.status === "unknown")).toBe(true);
		}
		role(join(root, "user"), "inspect-fixture", null);
		expect(inspectRole(cwd, "user", "inspect-fixture", true, []).worker).toMatchObject({ toolSelection: "default", mcp: "configured" });
	});
	it("does not configure MCP for a restricted local-only role", () => {
		expect(inspectRole(cwd, "user", "inspect-fixture", true, ["read"]).worker).toMatchObject({ mcp: "not_configured", builtinExtensions: [] });
	});
	it("matches canonical and alias trust/shadowing across scopes", () => {
		role(join(cwd, ".pi"), "inspect-fixture", "bash", "project-alias");
		expect(inspectRole(cwd, "user", "inspect-alias", false, []).role.source).toBe("user");
		for (const scope of ["project", "both"] as const) {
			for (const name of ["inspect-fixture", "project-alias"]) {
				expect(() => inspectRole(cwd, scope, name, false, [])).toThrow("not trusted");
				expect(inspectRole(cwd, scope, name, true, []).role.source).toBe("project");
			}
		}
		// Project shadowing happens before filtering: do not resurrect the user role.
		expect(() => inspectRole(cwd, "both", "inspect-alias", false, [])).toThrow("Unknown or withheld");
		expect(() => inspectRole(cwd, "user", "missing", true, [])).toThrow("Unknown or withheld");
	});
	it("registered tool bypasses probes/setup even with refresh and parent-only registration", async () => {
		const fake = createFakePi(); readiness(fake.api);
		const metadata = fake.api.getAllTools()[0];
		vi.spyOn(fake.api, "getAllTools").mockReturnValue([{ ...metadata, name: "parent_only" }]);
		let ctx: ExtensionContext | undefined;
		fake.api.on("agent_end", (_event, context) => { ctx = context; });
		await fake.emit({ type: "agent_end", messages: [] }, { cwd });
		if (!ctx) throw new Error("missing test context");
		const execute = fake.tools.find((tool) => tool.name === "readiness")!.definition.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: { roleInspection?: ReturnType<typeof inspectRole> }; isError?: boolean }>;
		const report = await execute("test", { agent: "inspect-alias", refresh: true }, undefined, undefined, ctx);
		expect(report.isError).not.toBe(true);
		expect(report.details.roleInspection?.parentRegistration.tools).toContainEqual({ name: "parent_only", status: "registered" });
		expect(report.content[0].text).toContain("Worker registration and service health: unknown");
		expect(report.content[0].text).not.toContain("PRIVATE ROLE PROMPT");
		ctx.isProjectTrusted = () => false;
		role(join(cwd, ".pi"), "inspect-fixture", "bash");
		const refusal = await execute("test", { agent: "inspect-alias", agentScope: "both" }, undefined, undefined, ctx);
		expect(refusal.isError).toBe(true);
		const render = fake.tools.find((tool) => tool.name === "readiness")!.definition.renderResult as (result: unknown, options: unknown, theme: { fg: (color: string, text: string) => string }) => { render: (width: number) => string[] };
		expect(render(refusal, {}, { fg: (_color, text) => text }).render(200).join("\n")).toContain("not trusted");
		vi.spyOn(fake.api, "getAllTools").mockImplementation(() => { throw new Error("registry unavailable"); });
		const unknown = await execute("test", { agent: "inspect-fixture", agentScope: "user", refresh: true }, undefined, undefined, ctx);
		expect(unknown.details.roleInspection?.parentRegistration.status).toBe("unknown");
		expect(unknown.details.roleInspection?.parentRegistration.tools.every((tool) => tool.status === "unknown")).toBe(true);
		expect((await execute("test", { agentScope: "both" }, undefined, undefined, ctx)).isError).toBe(true);
		expect(probes.realDeps).not.toHaveBeenCalled(); expect(probes.runAll).not.toHaveBeenCalled(); expect(mirror).not.toHaveBeenCalled();
		expect(fake.messages).toEqual([]); expect(fake.entries).toEqual([]); expect(fake.userMessages).toEqual([]);
	});
});
