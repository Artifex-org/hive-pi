import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { workerExtensionPaths } from "../extensions/subagent/worker.ts";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it.each([false, true])("real extension loader discovers Claude SDK with opt-in=%s without network or CLI", async enabled => {
	const dir = await mkdtemp(join(tmpdir(), "pi-claude-loader-")); dirs.push(dir);
	vi.stubEnv("HIVE_CLAUDE_SDK", enabled ? "1" : "0");
	vi.stubEnv("HIVE_CLAUDE_SDK_EXECUTABLE", "/nonexistent/pinned-native-claude");
	vi.stubEnv("HIVE_CLAUDE_SDK_STATE_DIR", join(dir, "private"));
	vi.stubEnv("HIVE_URL", "https://hive.invalid"); vi.stubEnv("HIVE_TOKEN", "synthetic"); vi.stubEnv("HIVE_LAUNCH_ID", "offline-launch");
	const entry = workerExtensionPaths().find(path => path === resolve("extensions/claude-sdk/index.ts"))!;
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({}),
		noExtensions: true, additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	expect(loaded.errors).toEqual([]);
	expect(loaded.extensions).toHaveLength(1);
	const registrations = loaded.runtime.pendingNativeProviderRegistrations;
	expect(registrations.map(item => item.provider.id)).toEqual(enabled ? ["claude-sdk"] : []);
	const hooks = [...loaded.extensions[0].handlers.keys()];
	expect(hooks).toEqual(enabled ? ["session_shutdown", "session_start", "session_compact", "session_tree", "model_select"] : []);
});

it.each([false, true])("manifest plus Hive CLI extension loads one provider with project override=%s", async overridden => {
	const dir = await mkdtemp(join(tmpdir(), "pi-claude-combined-loader-")); dirs.push(dir);
	const pkg = join(dir, "base"), agentDir = join(dir, "agent"), cwd = join(dir, "project");
	await mkdir(join(pkg, "extensions"), { recursive: true });
	await mkdir(agentDir); await mkdir(join(cwd, ".pi"), { recursive: true });
	await symlink(resolve("extensions/claude-sdk"), join(pkg, "extensions/claude-sdk"), "dir");
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "offline-sdk-loader", version: "0.0.0", pi: { extensions: ["./extensions"] } }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
	if (overridden) await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [{ source: pkg, extensions: [] }] }));
	vi.stubEnv("HIVE_CLAUDE_SDK", "1"); vi.stubEnv("HIVE_CLAUDE_SDK_EXECUTABLE", "/nonexistent/pinned-native-claude");
	vi.stubEnv("HIVE_CLAUDE_SDK_STATE_DIR", join(dir, "private"));
	vi.stubEnv("HIVE_URL", "https://hive.invalid"); vi.stubEnv("HIVE_TOKEN", "synthetic"); vi.stubEnv("HIVE_LAUNCH_ID", "offline-launch");
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const entry = join(pkg, "extensions/claude-sdk/index.ts");
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [entry],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	expect(loaded.errors).toEqual([]);
	expect(loaded.runtime.pendingNativeProviderRegistrations.filter(item => item.provider.id === "claude-sdk")).toHaveLength(1);
	expect(loaded.extensions.filter(extension => extension.path.endsWith("/claude-sdk/index.ts"))).toHaveLength(1);
});

// This executes only synthetic plugins, never the private profile or SDK.
// The real pinned loader and runner distinguish discovery, factory execution,
// deduplication and session lifecycle; presence of an explicit entry proves none
// of those on its own.
it.each([false, true])("explicit SDK-shaped entry preserves directory plugins and lifecycle unless discovery is disabled=%s", async noExtensions => {
	const root = await mkdtemp(join(tmpdir(), "pi-fake-plugin-discovery-")); dirs.push(root);
	const pkg = join(root, "package"), agentDir = join(root, "agent"), cwd = join(root, "project");
	await mkdir(join(pkg, "extensions/claude-sdk"), { recursive: true });
	await mkdir(agentDir); await mkdir(cwd);
	const markers = join(root, "loader-events.jsonl");
	for (const [name, file] of [["sdk", "claude-sdk/index.ts"], ["guard", "a-guard.ts"], ["hook", "b-hook.ts"]]) {
		await writeFile(join(pkg, "extensions", file), `import { appendFileSync } from "node:fs";
export default async function(pi) {
  const marker = phase => appendFileSync(${JSON.stringify(markers)}, phase + ":${name}\\n");
  await Promise.resolve();
  marker("factory");
  pi.on("session_start", async () => { await Promise.resolve(); marker("start"); });
}`);
	}
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "synthetic-full-directory", version: "0.0.0", pi: { extensions: ["./extensions"] } }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
	const loader = new DefaultResourceLoader({ cwd, agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
		additionalExtensionPaths: [join(pkg, "extensions/claude-sdk/index.ts")], noExtensions,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	expect(loaded.errors).toEqual([]);
	const names = noExtensions ? ["sdk"] : ["sdk", "guard", "hook"];
	expect(loaded.extensions).toHaveLength(names.length);
	const lines = async () => (await readFile(markers, "utf8")).trim().split("\n");
	expect(await lines()).toEqual(names.map(name => `factory:${name}`));
	const modelRuntime = await ModelRuntime.create({
		credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
		modelsPath: null, modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), new ModelRegistry(modelRuntime));
	const errors: string[] = [];
	runner.onError(() => errors.push("extension-error"));
	await runner.emit({ type: "session_start", reason: "startup" });
	expect(errors).toEqual([]);
	expect(await lines()).toEqual([...names.map(name => `factory:${name}`), ...names.map(name => `start:${name}`)]);
});
