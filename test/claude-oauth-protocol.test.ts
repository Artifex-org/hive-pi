import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context, Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildClaudeCodeBillingHeader,
	claudeCodeVersionFingerprint,
	createClaudeCodeFetch,
	discoverClaudeCodeIdentity,
	parseClaudeCodeIdentity,
	patchClaudeCodeCch,
	transformClaudeCodePayload,
	xxHash64,
} from "../extensions/claude-oauth/protocol.ts";

const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];
const promptMessages = (prompt: string): Message[] => [
	{ role: "user", content: prompt, timestamp: 1 },
];
const context = (prompt: string): Context => ({ messages: promptMessages(prompt) });
const deviceId = "f".repeat(64);
const accountUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("Claude OAuth protocol", () => {
	it("implements standard XXH64 vectors", () => {
		expect(xxHash64(encoder.encode("")).toString(16)).toBe("ef46db3751d8e999");
		expect(xxHash64(encoder.encode("hello")).toString(16)).toBe(
			"26c7827d889f6da3",
		);
	});

	it("reproduces the validated prompt fingerprint", async () => {
		expect(
			await claudeCodeVersionFingerprint(promptMessages("Reply with exactly: PROBE_OK")),
		).toBe("f97");
		expect(
			await buildClaudeCodeBillingHeader(promptMessages("Reply with exactly: PROBE_OK")),
		).toBe(
			"x-anthropic-billing-header: cc_version=2.1.224.f97; cc_entrypoint=sdk-cli; cch=00000;",
		);
	});

	it("discovers a validated local identity outside Hive launches", async () => {
		const root = await mkdtemp(join(tmpdir(), "claude-oauth-"));
		temporaryDirectories.push(root);
		const path = join(root, ".claude.json");
		await writeFile(path, JSON.stringify({ userID: deviceId, oauthAccount: { accountUuid } }));

		expect(await discoverClaudeCodeIdentity({}, path)).toEqual({ deviceId, accountUuid });
		expect(
			parseClaudeCodeIdentity({ userID: "bad", oauthAccount: { accountUuid } }),
		).toBeUndefined();
	});

	it("does not borrow workstation identity for a centrally assigned Hive account", async () => {
		const root = await mkdtemp(join(tmpdir(), "claude-oauth-"));
		temporaryDirectories.push(root);
		const path = join(root, ".claude.json");
		await writeFile(path, JSON.stringify({ userID: deviceId, oauthAccount: { accountUuid } }));

		expect(await discoverClaudeCodeIdentity({ HIVE_LAUNCH_ID: "launch-1" }, path)).toBeUndefined();
		expect(
			await discoverClaudeCodeIdentity({
				HIVE_LAUNCH_ID: "launch-1",
				CLAUDE_CODE_DEVICE_ID: deviceId,
				CLAUDE_CODE_ACCOUNT_UUID: accountUuid,
			}, path),
		).toEqual({ deviceId, accountUuid });
	});

	it("puts billing and Agent SDK blocks first while preserving Pi's prompt", async () => {
		const payload = await transformClaudeCodePayload(
			{
				model: "claude-opus-5",
				messages: [],
				max_tokens: 64_000,
				stream: true,
				system: [
					{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
					{ type: "text", text: "Pi system", cache_control: { type: "ephemeral" } },
				],
			},
			context("Reply with exactly: PROBE_OK"),
			"11111111-2222-4333-8444-555555555555",
			{ deviceId, accountUuid },
		);
		const system = payload.system as Array<Record<string, unknown>>;
		expect(system[0]).toEqual({
			type: "text",
			text: "x-anthropic-billing-header: cc_version=2.1.224.f97; cc_entrypoint=sdk-cli; cch=00000;",
		});
		expect(system[1]).toEqual({
			type: "text",
			text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
		});
		expect(system[2]).toMatchObject({ type: "text", text: "Pi system" });
		expect(payload.metadata).toEqual({
			user_id: JSON.stringify({
				device_id: deviceId,
				account_uuid: accountUuid,
				session_id: "11111111-2222-4333-8444-555555555555",
			}),
		});
	});

	it("is idempotent and omits unavailable identity", async () => {
		const first = await transformClaudeCodePayload(
			{
				model: "claude-opus-5",
				messages: [],
				max_tokens: 1,
				stream: true,
				system: [{ type: "text", text: "Pi system" }],
			},
			context("hello"),
			"session",
			undefined,
		);
		const second = await transformClaudeCodePayload(
			first,
			context("hello"),
			"session",
			undefined,
		);
		expect(second.system).toEqual(first.system);
		expect(second).not.toHaveProperty("metadata");
	});

	it("patches only the first billing block", () => {
		const body = {
			model: "claude-opus-5",
			messages: [{ role: "user", content: "cch=00000", max_tokens: 7 }],
			max_tokens: 64_000,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.224.000; cc_entrypoint=sdk-cli; cch=00000;",
				},
				{ type: "text", text: "fake cch=00000" },
			],
			tools: [{ name: "probe", description: "cch=00000", input_schema: { type: "object" } }],
		};
		const patched = JSON.parse(patchClaudeCodeCch(JSON.stringify(body))) as typeof body;
		expect(patched.system[0].text).toMatch(/cch=[0-9a-f]{5};$/u);
		expect(patched.system[0].text).not.toContain("cch=00000");
		expect(patched.messages).toEqual(body.messages);
		expect(patched.system[1]).toEqual(body.system[1]);
		expect(patched.tools).toEqual(body.tools);
	});

	it("reproduces the validated normalized-body checksum", () => {
		const body =
			'{"model":"claude-opus-5","messages":[{"role":"user","content":"A"}],"max_tokens":64000,"stream":true,"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.224.000; cc_entrypoint=sdk-cli; cch=00000;"}]}';
		expect(patchClaudeCodeCch(body)).toContain("cch=7ba34");
	});

	it("patches the final SDK body and adds a request UUID", async () => {
		const body = JSON.stringify({
			model: "claude-opus-5",
			messages: [],
			max_tokens: 1,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.224.000; cc_entrypoint=sdk-cli; cch=00000;",
				},
			],
		});
		const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		await createClaudeCodeFetch(transport)("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: { authorization: "Bearer secret" },
			body,
		});

		const [, init] = transport.mock.calls[0];
		expect(String(init?.body)).toMatch(/cch=[0-9a-f]{5}/u);
		const headers = new Headers(init?.headers);
		expect(headers.get("x-client-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
		expect(headers.get("authorization")).toBe("Bearer secret");
	});
});

