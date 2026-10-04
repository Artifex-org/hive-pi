/** Opt-in browser fixture: real scanner + hive-remote + Hive panel, synthetic provider/API.
 * HIVE_WEB_WORKTREE=/path/to/hive node --experimental-strip-types test/you-should-know-web-preview.mjs
 * Requires Hive web dependencies; binds loopback only; never uses operator credentials.
 * Server authorization is covered separately by Hive's managed-Postgres API tests.
 */
import { createServer as httpServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createFakePi } from "./fake-pi.ts";
import hiveRemote from "../extensions/hive-remote/index.ts";
import { loadConfig } from "../extensions/hive-remote/config.ts";
import { wireYouShouldKnow, DEFAULT_CONFIG } from "../extensions/you-should-know/index.ts";
import { HIVE_SESSION_CHANNEL } from "../extensions/hive-common/channels.ts";
import { YSK_STATE_CHANNEL } from "../extensions/hive-common/you-should-know.ts";

if (!process.env.HIVE_WEB_WORKTREE) throw new Error("Set HIVE_WEB_WORKTREE to the Hive checkout containing the web panel and installed web dependencies.");
const web = join(resolve(process.env.HIVE_WEB_WORKTREE), "web");
const preview = mkdtempSync(join(web, ".ysk-preview-"));
const home = mkdtempSync(join(tmpdir(), "ysk-browser-"));
const oldHome = process.env.HOME;
process.env.HOME = home;
const quote = "The migration was not tested against production data.";
const note = { kind: "caveat", text: "Production-data verification is still missing.", quote };
const fake = createFakePi();
const rpc = { mode: "rpc", hasUI: false };
let snapshot;
let supported = false;
let lastSeq = 0;
const commands = [];
const durable = [];
const streams = new Set();
let currentNote = note;
let scannerReading;
fake.api.events.on(YSK_STATE_CHANNEL, value => { scannerReading = value; });
const reply = text => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "fixture", stopReason: "stop", timestamp: Date.now(),
  usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } });
const api = httpServer(async (req, res) => {
  try {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const path = req.url.split("?")[0];
    const viewer = req.headers.authorization === "Bearer fixture-viewer";
    let result;
    if (path.endsWith("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(': fixture stream\n\n'); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    if (path.includes("/by-run/")) result = { id: "fixture-session" };
    else if (path.endsWith("/conversation")) {
      if (req.method === "PUT") supported = body.can_control_you_should_know === true;
      let reading = snapshot;
      if (viewer && reading) { const { tokens, cost, command_id, ...content } = reading; reading = content; }
      result = { session_id: "fixture-session", last_seq: lastSeq, title: "Scanner fixture", source: "workstation", read_only: viewer,
        can_steer: !viewer, can_interrupt: !viewer, can_control_you_should_know: !viewer && supported, you_should_know: reading,
        activity_phase: "idle", last_seen_at: new Date().toISOString() };
    } else if (path.endsWith("/credential-state")) result = { base: [], granted: [] };
    else if (req.method === "GET" && /\/(commands|questions|requests|reviews|shares)$/.test(path)) result = { items: [] };
    else if (path.endsWith("/status")) {
      result = {};
      snapshot = body.you_should_know;
      for (const stream of streams) stream.write('data: {"kind":"status"}\n\n');
    } else if (path.endsWith("/events")) {
      if (req.method === "POST") {
        durable.push(...(body.events ?? []).filter(e => !durable.some(old => old.seq === e.seq)));
        lastSeq = Math.max(lastSeq, ...(body.events ?? []).map(e => e.seq)); result = { last_seq: lastSeq };
      } else result = { items: durable, last_seq: lastSeq, more_before: false };
    }
    else if (path.endsWith("/commands/claim")) result = { items: commands.splice(0) };
    else if (path.endsWith("/you-should-know")) {
      if (viewer || !supported || !["on", "off", "dismiss"].includes(body.action)) { res.writeHead(403); res.end(JSON.stringify({ error: "fixture control refused" })); return; }
      result = { id: randomUUID(), session_id: "fixture-session", kind: "you_should_know", payload: JSON.stringify(body),
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() };
      commands.push(result); res.statusCode = 202;
    } else if (path === "/api/fixture/prose") {
      result = {};
      currentNote = note;
      await fake.emit({ type: "message_end", message: reply(`Updated the files. ${quote} Ready for review.`) }, rpc);
      await fake.emit({ type: "agent_settled" }, rpc);
    } else if (path === "/api/fixture/stress") {
      result = {};
      if (!scannerReading?.enabled) throw new Error("Turn scanning on before layout stress");
      for (let i = 1; i <= 10; i++) {
        currentNote = { kind: "caveat", text: (`Maximum-length caveat ${i}: ` + "x".repeat(200)).slice(0, 200), quote: (`Evidence item ${i}: ` + "x".repeat(240)).slice(0, 240) };
        const before = scannerReading.scans;
        const done = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { off(); reject(new Error("Fixture scanner did not finish")); }, 10000);
          const off = fake.api.events.on(YSK_STATE_CHANNEL, reading => {
            if (reading.scans > before && reading.phase === "idle") { clearTimeout(timeout); off(); resolve(); }
          });
        });
        await fake.emit({ type: "message_end", message: reply(currentNote.quote) }, rpc);
        await fake.emit({ type: "agent_settled" }, rpc);
        await done;
      }
    }
    if (result === undefined) { res.writeHead(404); res.end(JSON.stringify({ error: "Optional API outside this fixture's scope" })); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${api.address().port}`;
hiveRemote(fake.api, { loadConfig: () => ({ ...loadConfig(), enabled: true, url: base, flushIntervalMs: 100,
  reportActivity: false, reportWorktree: false, streamDeltas: true, reportStatus: true, allowSetMode: true }),
  resolveAuth: () => ({ token: "fixture-owner", url: base, source: "fixture" }) });
wireYouShouldKnow(fake.api, { ...DEFAULT_CONFIG, intervalMs: 100, timeoutMs: 5000 }, async () => reply(JSON.stringify({ notes: [currentNote] })));
await fake.emit({ type: "session_start", reason: "startup" }, rpc);
fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "fixture-run" });

const imports = path => JSON.stringify(`/@fs/${join(web, "src", path)}`);
// A nested fixture root must explicitly include the real panel's utility classes.
writeFileSync(join(preview, "fixture.css"), '@import "../src/index.css";\n@source "../src";\n');
writeFileSync(join(preview, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>You Should Know browser fixture</title></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
writeFileSync(join(preview, "entry.tsx"), `
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { AgentSessionPane } from ${imports("routes/Agents.session.tsx")};
import { YouShouldKnowPanel } from ${imports("routes/Agents.youShouldKnow.tsx")};
import { api } from ${imports("lib/api.ts")};
import "./fixture.css";
const viewer = new URLSearchParams(location.search).has("viewer");
localStorage.setItem("hive_token", viewer ? "fixture-viewer" : "fixture-owner");
document.documentElement.dataset.theme = new URLSearchParams(location.search).has("light") ? "light" : "dark";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const noop = () => {};
function Preview() {
  const [draft, setDraft] = React.useState("");
  const actual = new URLSearchParams(location.search).has("session");
  const q = useQuery({ queryKey: ["agent-conversation", "fixture-session"], queryFn: () => api.getAgentConversation("fixture-session"), refetchInterval: 250 });
  return <main className="mx-auto flex h-dvh max-w-3xl flex-col border-x border-edge bg-surface-0 text-ink">
    <header className="border-b border-edge px-4 py-3"><h1 className="text-sm font-medium">Scanner browser fixture</h1><p className="mt-1 text-xs text-ink-muted">Real client extensions and web panel · synthetic provider/API · {viewer ? "shared viewer" : "session owner"}</p></header>
    {actual ? <><button className="shrink-0 border-b border-edge p-2 text-xs" onClick={() => fetch("/api/fixture/stress", { method: "POST" })}>Generate ten long notes</button><AgentSessionPane sessionId="fixture-session" title="Scanner fixture" project="hive" shared={viewer} source="workstation" onConversation={noop} onTasks={noop} onDelegations={noop} onRefs={noop} onReadiness={noop} onApplied={noop} draft={draft} onDraft={setDraft} planSignal={0} onPlanSignal={noop} onPlanMode={noop} onWorkflowSignal={noop} /></> : <><div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm"><p>Updated the files. ${quote} Ready for review.</p><button className="mt-3 rounded border border-edge-bright p-2 text-xs focus-visible:outline-2 focus-visible:outline-accent" onClick={() => fetch("/api/fixture/prose", { method: "POST" })}>Generate caveat</button></div>
    <YouShouldKnowPanel sessionId="fixture-session" snapshot={q.data?.you_should_know} canControl={Boolean(q.data?.can_control_you_should_know)} readOnly={viewer} activity={{ phase: "idle", atMs: 0 }} />
    <footer className="shrink-0 border-t border-edge bg-surface-1 p-3"><label className="text-xs text-ink-muted" htmlFor="compose">Message agent</label><textarea id="compose" className="mt-1 block h-20 w-full resize-none rounded border border-edge-bright bg-surface-0 p-2 text-sm focus-visible:outline-2 focus-visible:outline-accent" placeholder="Composer stays reachable" /></footer></>}
  </main>;
}
const rootRoute = createRootRoute();
const route = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Preview });
const router = createRouter({ routeTree: rootRoute.addChildren([route]) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
`);
const require = createRequire(join(web, "package.json"));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
// The Vite dev-token helper must never inject the inherited operator token.
const token = process.env.HIVE_TOKEN; delete process.env.HIVE_TOKEN;
const vite = await createServer({ configFile: join(web, "vite.config.ts"), root: preview,
  server: { host: "127.0.0.1", port: Number(process.env.YSK_PREVIEW_PORT ?? 5184), strictPort: true,
    proxy: { "/api": base }, fs: { allow: [web] } } });
if (token !== undefined) process.env.HIVE_TOKEN = token;
await vite.listen();
console.log(`You Should Know fixture: http://127.0.0.1:${vite.config.server.port}/`);
console.log("Generate caveat → expand quote → turn off/on → dismiss → reload → ?viewer=1 → ?light=1 → ?session=1 for actual pane and ten-note stress; SIGINT/SIGTERM cleans up.");
console.log(`Temporary fixture paths: ${preview} ${home}`);
const cleanup = () => { rmSync(preview, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); };
process.once("exit", cleanup);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // The background-job owner may send SIGKILL after a short shutdown grace.
  cleanup();
  await fake.emit({ type: "session_shutdown" }, rpc);
  await vite.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  cleanup(); process.exit(0);
}
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
