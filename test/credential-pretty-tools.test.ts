import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import prettyTools, { resetTerminalSurface } from "../extensions/pretty-tools.ts";
import * as ptyOps from "../extensions/pty-exec/ops.ts";
import { bindCredentialSession, clearCredentialGrants, installCredentialGrant } from "../extensions/hive-remote/credential-runtime.ts";
import { createFakePi } from "./fake-pi.ts";

const secret = "pretty-tools-real-pty-credential-4f19";
const sessionID = "pretty-tools-credential-session";
const envName = "PRETTY_TOOLS_FIXTURE_SECRET";

function grant(): void {
 const binding = bindCredentialSession(sessionID, "hive-session-fixture", 1);
 expect(installCredentialGrant(binding, "pretty-tools-grant", Date.now() + 60_000,
  [{ name: "fixture", env_var: envName, value: secret }])).toBe(true);
}

function registeredTool(fake: ReturnType<typeof createFakePi>) {
 prettyTools(fake.api);
 const tool = fake.tools.find(item => item.name === "bash")?.definition;
 if (!tool) throw new Error("pretty-tools did not register bash");
 return tool as unknown as { execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: ((value: unknown) => void) | undefined, ctx: ExtensionToolContext): Promise<{ content: unknown; details?: unknown }> };
}

function context(fake: ReturnType<typeof createFakePi>): ExtensionToolContext {
 const commandctx = Object.create({ sessionManager: { getSessionId: () => sessionID, getSessionFile: () => undefined } }, {
  cwd: { value: process.cwd() },
  tools: { value: fake.api.getAllTools() },
  executeTool: { value: async () => { throw new Error("unexpected nested tool call"); } },
 });
 return commandctx as ExtensionToolContext;
}

function assertRedacted(text: string): void {
 expect(text).not.toContain(secret);
 expect(text).not.toContain(secret.slice(0, 12));
 expect(text).toContain("[credential redacted]");
}

afterEach(() => {
 resetTerminalSurface();
 clearCredentialGrants();
 vi.restoreAllMocks();
 vi.unstubAllEnvs();
});

describe("registered pretty-tools bash credential wiring", () => {
 it("redacts real PTY raw terminal output and model result", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pretty-tools-home-"));
  const oldEnv = { pty: process.env.PI_PTY_BASH, dir: process.env.HIVE_TERMINAL_SURFACE_DIR, frame: process.env.HIVE_TERMINAL_FRAME_FIFO, control: process.env.HIVE_TERMINAL_CONTROL_FIFO, manifest: process.env.HIVE_TERMINAL_SURFACE_MANIFEST, launch: process.env.HIVE_LAUNCH_ID };
  const restoreHome = vi.spyOn(os, "homedir").mockReturnValue(home);
  let bridgeSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
   const dir = path.join(home, ".hive", "scratch", "credential-surface");
   fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
   for (const fifo of ["frames.fifo", "control.fifo"]) execFileSync("mkfifo", ["-m", "600", path.join(dir, fifo)]);
   vi.stubEnv("PI_PTY_BASH", "1");
   vi.stubEnv("HIVE_TERMINAL_SURFACE_DIR", dir);
   vi.stubEnv("HIVE_TERMINAL_FRAME_FIFO", path.join(dir, "frames.fifo"));
   vi.stubEnv("HIVE_TERMINAL_CONTROL_FIFO", path.join(dir, "control.fifo"));
   vi.stubEnv("HIVE_TERMINAL_SURFACE_MANIFEST", path.join(dir, "manifest.json"));
   vi.stubEnv("HIVE_LAUNCH_ID", "11111111-2222-3333-4444-555555555555");
   grant();
   const writes: Buffer[] = [];
   bridgeSpy = vi.spyOn((await import("../extensions/pty-exec/terminalSurface.ts")).TerminalSurfaceBridge.prototype, "writeOutput").mockImplementation(function (chunk: Buffer) { writes.push(Buffer.from(chunk)); });
   const fake = createFakePi(); const tool = registeredTool(fake); const updates: unknown[] = [];
   const result = await tool.execute("credential-pty-call", { command: `printf '%s\\n' "$${envName}"; sleep 0.05; printf '%s\\n' "$${envName}"`, timeout: 5 }, undefined, value => updates.push(value), context(fake));
   const raw = Buffer.concat(writes).toString();
   expect(writes.length).toBeGreaterThan(0);
   assertRedacted(raw); assertRedacted(JSON.stringify(result)); assertRedacted(JSON.stringify(updates));
   expect(process.env[envName]).toBeUndefined();
  } finally {
   restoreHome.mockRestore();
   for (const [name, value] of Object.entries({ PI_PTY_BASH: oldEnv.pty, HIVE_TERMINAL_SURFACE_DIR: oldEnv.dir, HIVE_TERMINAL_FRAME_FIFO: oldEnv.frame, HIVE_TERMINAL_CONTROL_FIFO: oldEnv.control, HIVE_TERMINAL_SURFACE_MANIFEST: oldEnv.manifest, HIVE_LAUNCH_ID: oldEnv.launch })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
   }
   fs.rmSync(home, { recursive: true, force: true });
  }
 });

 it("retries pty-unavailable through stock SDK with child grant env and redaction", async () => {
  const before = process.env[envName];
  grant(); vi.stubEnv("PI_PTY_BASH", "1");
  const exec = vi.spyOn(ptyOps, "ptyBashOperations").mockReturnValue({
   exec: async () => { throw new Error("pty-unavailable"); },
  } as ReturnType<typeof ptyOps.ptyBashOperations>);
  const fake = createFakePi(); const tool = registeredTool(fake); const updates: unknown[] = [];
  const result = await tool.execute("credential-retry-call", { command: `printf '%s\\n' "$${envName}"`, timeout: 5 }, undefined, value => updates.push(value), context(fake));
  expect(exec).toHaveBeenCalledOnce();
  assertRedacted(JSON.stringify(result)); assertRedacted(JSON.stringify(updates));
  expect(process.env[envName]).toBe(before);
 });
});
