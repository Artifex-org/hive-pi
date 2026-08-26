import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	Context,
	Model,
	Provider,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import claudeOAuth from "../extensions/claude-oauth/index.ts";
import {
	isSupportedPiVersion,
	supportedPiVersions,
} from "../extensions/claude-oauth/compatibility.ts";
import { pinnedPiVersion } from "../extensions/hive-common/piVersion.ts";
import { wrapAnthropicProvider } from "../extensions/claude-oauth/provider.ts";

const context: Context = {
	systemPrompt: "Pi system",
	messages: [{ role: "user", content: "Reply with exactly: PROBE_OK", timestamp: 1 }],
};
const model = {
	id: "claude-test",
	provider: "anthropic",
	api: "anthropic-messages",
} as Model<Api>;
const streamResult = {} as AssistantMessageEventStream;

function fakeProvider() {
	let streamOptions: ApiStreamOptions<Api> | undefined;
	let simpleOptions: SimpleStreamOptions | undefined;
	const provider = {
		id: "anthropic",
		name: "Anthropic",
		stream<T extends Api>(
			_model: Model<T>,
			_context: Context,
			options?: ApiStreamOptions<T>,
		) {
			streamOptions = options;
			return streamResult;
		},
		streamSimple(
			_model: Model<Api>,
			_context: Context,
			options?: SimpleStreamOptions,
		) {
			simpleOptions = options;
			return streamResult;
		},
	} as Provider;
	return {
		provider,
		getStreamOptions: () => streamOptions,
		getSimpleOptions: () => simpleOptions,
	};
}

describe("Claude OAuth provider wrapper", () => {
	it("passes API-key requests through by object identity", () => {
		const fake = fakeProvider();
		const wrapped = wrapAnthropicProvider(fake.provider, undefined);
		const options: SimpleStreamOptions = {
			apiKey: "sk-ant-api-key",
			headers: { "x-test": "yes" },
		};
		wrapped.streamSimple(model, context, options);
		expect(fake.getSimpleOptions()).toBe(options);
	});

	it("wraps both stream APIs for OAuth tokens", async () => {
		const fake = fakeProvider();
		const wrapped = wrapAnthropicProvider(fake.provider, {
			deviceId: "f".repeat(64),
			accountUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		});
		const priorTransform = vi.fn(async (payload: unknown) => ({
			...(payload as object),
			later_extension: true,
		}));
		const options = {
			apiKey: "sk-ant-oat-test",
			sessionId: "11111111-2222-4333-8444-555555555555",
			onPayload: priorTransform,
		};
		wrapped.stream(model, context, options);
		wrapped.streamSimple(model, context, options);

		for (const transformed of [fake.getStreamOptions(), fake.getSimpleOptions()]) {
			const payload = await transformed?.onPayload?.(
				{
					model: "claude-test",
					messages: [],
					max_tokens: 1,
					stream: true,
					system: [
						{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
					],
				},
				model,
			);
			expect(payload).toMatchObject({ later_extension: true });
			const system = (payload as { system: Array<{ text: string }> }).system;
			expect(system[0].text).toMatch(/^x-anthropic-billing-header:/u);
			expect(system[1].text).toBe(
				"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
			);
			expect(transformed?.headers).toMatchObject({
				"user-agent": "claude-cli/2.1.224 (external, sdk-cli)",
				"x-app": "cli",
				"x-claude-code-session-id": "11111111-2222-4333-8444-555555555555",
			});
		}
		expect(priorTransform).toHaveBeenCalledTimes(2);
	});

	it("declines instead of refusing to start Pi when the version is not validated", async () => {
		// The bug this replaces: an unvalidated Pi THREW at extension load, which
		// does not decline the wrapper — it stops Pi booting and takes every other
		// extension with it, hive-remote included. On 2026-08-26 that turned a
		// patch bump into 18 of 33 agent launches never attaching a session.
		//
		// The compatibility module is mocked WHOLE, not partially: a partial mock
		// leaves the untouched exports undefined and fails the entire file.
		vi.resetModules();
		vi.doMock("../extensions/claude-oauth/compatibility.ts", () => ({
			EXTRA_VALIDATED_PI_VERSIONS: [] as readonly string[],
			supportedPiVersions: () => ["0.84.2"],
			isSupportedPiVersion: () => false,
		}));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { default: declining } = await import("../extensions/claude-oauth/index.ts");
			const registerProvider = vi.fn<(provider: Provider) => void>();
			const on = vi.fn();
			expect(() =>
				declining({ registerProvider, on } as unknown as ExtensionAPI),
			).not.toThrow();
			// Declined: no provider wrapped, and no session hook installed either.
			expect(registerProvider).not.toHaveBeenCalled();
			expect(on).not.toHaveBeenCalled();
			// And it says so — a silent downgrade of subscription traffic would be
			// its own defect.
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("DISABLED");
		} finally {
			warn.mockRestore();
			vi.doUnmock("../extensions/claude-oauth/compatibility.ts");
			vi.resetModules();
		}
	});

	it("registers the wrapped runtime provider on validated Pi versions", async () => {
		expect(isSupportedPiVersion(VERSION)).toBe(true);
		// Derived from the repo's own pin, never restated. A literal here is what
		// went stale and refused to start Pi at all on 2026-08-26.
		expect(supportedPiVersions()).toEqual([pinnedPiVersion()]);
		expect(isSupportedPiVersion("0.0.0-not-validated")).toBe(false);
		const registerProvider = vi.fn<(provider: Provider) => void>();
		let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;

		claudeOAuth({
			registerProvider,
			on: (event: string, handler: unknown) => {
				if (event === "session_start") {
					start = handler as (event: unknown, ctx: unknown) => Promise<void>;
				}
			},
		} as unknown as ExtensionAPI);
		expect(registerProvider).not.toHaveBeenCalled();
		await start?.({}, { modelRegistry: { getProvider: () => fakeProvider().provider } });

		expect(registerProvider).toHaveBeenCalledOnce();
		expect(registerProvider.mock.calls[0][0].id).toBe("anthropic");
	});
});
