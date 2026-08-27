import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// resolveAuth's candidate ORDER is the contract under test. Interactively the
// stored /hive-login credential outranks $HIVE_TOKEN; in a LAUNCHED session
// (hive-agent injects HIVE_LAUNCH_ID and mints $HIVE_TOKEN for exactly that
// run) the ranking inverts, because a stale stored token shadowing the fresh
// launch token is how a launched session 401s on every call and sits at
// "session attaching…" forever (2026-08-11, on a linux workstation).

const home = mkdtempSync(join(tmpdir(), "hive-auth-test-"));

vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => home,
}));

const { resolveAuth } = await import("../extensions/hive-common/identity.ts");

const ENV_KEYS = ["HIVE_TELEMETRY_TOKEN", "HIVE_TOKEN", "HIVE_LAUNCH_ID", "HIVE_TELEMETRY_URL", "HIVE_URL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function clearEnv(): void {
	for (const k of ENV_KEYS) delete process.env[k];
}

function writeStored(token: string): void {
	const dir = join(home, ".pi", "agent", "hive-telemetry");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "credentials.json"), JSON.stringify({ token, url: "https://stored.example" }));
}

beforeAll(() => {
	clearEnv();
	writeStored("hive_stored");
});

afterEach(() => {
	clearEnv();
});

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
});

describe("resolveAuth precedence, interactive session", () => {
	it("prefers the stored /hive-login credential over $HIVE_TOKEN", () => {
		process.env.HIVE_TOKEN = "hive_env";
		const auth = resolveAuth();
		expect(auth?.token).toBe("hive_stored");
		expect(auth?.source).toBe("credentials.json");
	});

	it("falls back to $HIVE_TOKEN url resolution via $HIVE_URL when nothing else names one", () => {
		process.env.HIVE_TOKEN = "hive_env";
		process.env.HIVE_URL = "https://env.example/";
		const auth = resolveAuth();
		// Stored url still wins for the url; trailing slash is normalized off.
		expect(auth?.url).toBe("https://stored.example");
	});

	it("$HIVE_TELEMETRY_TOKEN overrides everything", () => {
		process.env.HIVE_TELEMETRY_TOKEN = "hive_override";
		process.env.HIVE_TOKEN = "hive_env";
		const auth = resolveAuth();
		expect(auth?.token).toBe("hive_override");
		expect(auth?.source).toBe("$HIVE_TELEMETRY_TOKEN");
	});
});

describe("resolveAuth precedence, launched session (HIVE_LAUNCH_ID set)", () => {
	it("prefers the launch-minted $HIVE_TOKEN over the stored credential", () => {
		process.env.HIVE_LAUNCH_ID = "b196f659-0000-0000-0000-000000000000";
		process.env.HIVE_TOKEN = "hive_launch";
		const auth = resolveAuth();
		expect(auth?.token).toBe("hive_launch");
		expect(auth?.source).toBe("$HIVE_TOKEN");
	});

	it("still falls back to the stored credential when the launcher provided no token", () => {
		process.env.HIVE_LAUNCH_ID = "b196f659-0000-0000-0000-000000000000";
		const auth = resolveAuth();
		expect(auth?.token).toBe("hive_stored");
		expect(auth?.source).toBe("credentials.json");
	});

	it("$HIVE_TELEMETRY_TOKEN still overrides the launch token", () => {
		process.env.HIVE_LAUNCH_ID = "b196f659-0000-0000-0000-000000000000";
		process.env.HIVE_TELEMETRY_TOKEN = "hive_override";
		process.env.HIVE_TOKEN = "hive_launch";
		const auth = resolveAuth();
		expect(auth?.token).toBe("hive_override");
		expect(auth?.source).toBe("$HIVE_TELEMETRY_TOKEN");
	});
});
