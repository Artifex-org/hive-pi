import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashTool, createLocalBashOperations, type ToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import background from "../extensions/background/index.ts";
import { ptyBashOperations } from "../extensions/pty-exec/ops.ts";
import { bindCredentialSession, clearCredentialGrants, credentialOperations, credentialRedactor, installCredentialGrant } from "../extensions/hive-remote/credential-runtime.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const secret = "fixture-literal-credential-83";
const interleave = 'printf "%s" "${FIXTURE_CREDENTIAL:0:7}"; sleep 0.04; printf "diagnostic\\n" >&2; sleep 0.04; printf "%s\\n" "${FIXTURE_CREDENTIAL:7}"';
function install(local: string) {
	const binding = bindCredentialSession(local, "hive-fixture", 1);
	expect(installCredentialGrant(binding, "grant-fixture", Date.now() + 60_000,
		[{ name: "fixture", env_var: "FIXTURE_CREDENTIAL", value: secret }])).toBe(true);
}
function expectSafe(text: string) {
	expect(text).not.toContain(secret);
	expect(text).not.toContain(secret.slice(0, 7));
	expect(text).toContain("[credential redacted]");
}
async function invoke(fake: FakePi, name: string, params: Record<string, unknown>): Promise<string> {
	let text = "";
	fake.api.registerCommand("probe", { handler: async (_args, ctx) => {
		const definition = fake.tools.find(tool => tool.name === name)?.definition;
		if (!definition) throw new Error(`Missing tool ${name}`);
		const execute = definition.execute as ToolDefinition["execute"];
		const toolCtx: ExtensionToolContext = Object.create(ctx, {
			tools: { value: fake.api.getAllTools() },
			executeTool: { value: async () => { throw new Error("Unexpected tool nesting"); } },
		});
		text = JSON.stringify(await execute("fixture-call", params, undefined, undefined, toolCtx));
	} });
	await fake.runCommand("probe", "", { sessionId: "background-local", mode: "tui", cwd: process.cwd() });
	return text;
}
afterEach(() => { clearCredentialGrants(); vi.unstubAllEnvs(); });
describe("real shell credential boundaries", () => {
	it("redacts actual SDK stdout/stderr before updates, result and spilled output", async () => {
		install("sdk-local");
		const bash = createBashTool(process.cwd(), { operations: credentialOperations(createLocalBashOperations(), "sdk-local") });
		const updates: unknown[] = [];
		const result = await bash.execute("sdk-call", { command: `${interleave}; for ((i=0;i<4000;i++)); do printf "%s\\n" "$FIXTURE_CREDENTIAL"; done` }, undefined, update => updates.push(update));
		expectSafe(JSON.stringify(result));
		expectSafe(JSON.stringify(updates));
		expect(result.details?.fullOutputPath).toBeTruthy();
		const path = result.details!.fullOutputPath!;
		try { expectSafe(readFileSync(path, "utf8")); } finally { rmSync(path, { force: true }); }
		expect(process.env.FIXTURE_CREDENTIAL).toBeUndefined();
	});
	it("redacts actual PTY model and raw-sink output across receiver detach", async () => {
		vi.stubEnv("PI_PTY_BASH", "1"); // Test-process override only; no user configuration is written.
		install("pty-local");
		const raw = credentialRedactor("pty-local"), chunks: Buffer[] = [];
		const operations = ptyBashOperations({ onRaw: chunk => {
			chunks.push(raw.push(chunk)); clearCredentialGrants();
		} });
		expect(operations).toBeDefined();
		if (!operations) throw new Error("PTY test requires Linux script utility");
		const bash = createBashTool(process.cwd(), { operations: credentialOperations(operations, "pty-local") });
		const result = await bash.execute("pty-call", { command: 'printf "%s\\n" "$FIXTURE_CREDENTIAL"; sleep 0.04; printf "%s\\n" "$FIXTURE_CREDENTIAL"', timeout: 5 });
		chunks.push(raw.flush());
		expectSafe(JSON.stringify(result)); expectSafe(Buffer.concat(chunks).toString());
		expect(process.env.FIXTURE_CREDENTIAL).toBeUndefined();
	});
	it("protects background notification and retained output after receiver detach", async () => {
		const fake = createFakePi(); background(fake.api);
		await fake.emit({ type: "session_start" }, { sessionId: "background-local", mode: "tui" });
		install("background-local");
		try {
			expect(await invoke(fake, "background_bash", { command: `sleep 0.05; ${interleave}`, what: "a credential boundary test" })).toContain("Started");
			clearCredentialGrants();
			await vi.waitFor(() => expect(fake.messages.length).toBeGreaterThan(0), { timeout: 4000 });
			expectSafe(JSON.stringify(fake.messages));
			expectSafe(await invoke(fake, "background_result", { id: "bg-1" }));
			expect(process.env.FIXTURE_CREDENTIAL).toBeUndefined();
		} finally { await fake.emit({ type: "session_shutdown" }); }
	});
});
