import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { nextDevServerReport, probeLoopbackStatus, sourceFor, validateMaestroYAML, validatePlaywrightSource } from "../extensions/flows/register.ts";

describe("agent flows", () => {
  it("rewrites recorded navigation to the runtime-resolved base URL", () => {
    const source = sourceFor([
      { kind: "navigate", url: "http://127.0.0.1:5173/dashboard?tab=recent" },
      { kind: "click", selector: 'role=button[name="Refresh"]' },
      { kind: "fill", selector: 'role=textbox[name="Search"]', value: "flow", submit: true },
    ], "http://127.0.0.1:5173");

    expect(source).toContain('new URL("/dashboard?tab=recent", baseURL)');
    expect(source).not.toContain("127.0.0.1:5173");
    expect(source).toContain('await page.click("role=button[name=\\"Refresh\\"]")');
    expect(source).toContain('await page.press("role=textbox[name=\\"Search\\"]", "Enter")');
  });

  it("does not preserve navigation to another origin", () => {
    const source = sourceFor([{ kind: "navigate", url: "https://example.com/" }], "http://127.0.0.1:5173");
    expect(source).not.toContain("example.com");
  });

  it("keeps the active resource generation and sequence when re-reporting a warmed server", () => {
    const prior = { baseURL: new URL("http://127.0.0.1:5173"), generation: "e9ef8518-d2d3-4fe2-81a7-5a6a1d22dd4c", sequence: 4 };
    expect(nextDevServerReport(prior, new URL("http://127.0.0.1:3000"))).toEqual({
      baseURL: new URL("http://127.0.0.1:3000"),
      generation: prior.generation,
      sequence: prior.sequence,
    });
  });

  it("probes the reported loopback server directly, never through the egress proxy", async () => {
    // A node that allowlists 127.0.0.1 drops loopback from NO_PROXY (HIV-3157);
    // a fetch-based probe then hits the host's loopback via the mux and reports
    // its 502. Point the proxy env at a port nothing listens on: a probe that
    // consulted it would fail, a direct socket reaches the server.
    const server = createServer((_req, res) => { res.statusCode = 204; res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY };
    process.env.HTTP_PROXY = process.env.http_proxy = "http://127.0.0.1:9";
    process.env.NO_PROXY = process.env.no_proxy = "169.254.0.0/16";
    // The srt sandbox runs Node with NODE_USE_ENV_PROXY=1, which makes even
    // http.request honour HTTP_PROXY through the GLOBAL agent. The env var is
    // read at process start, so this test cannot flip it for itself: the control
    // below runs a child with it set and proves the default agent is proxied
    // (dead proxy → connection refused) while the private-agent probe is not.
    const url = new URL(`http://127.0.0.1:${address.port}/`);
    try {
      expect(await probeLoopbackStatus(url)).toBe(204);
      await expect(probeLoopbackStatus(new URL("http://127.0.0.1:9/"), 500)).rejects.toThrow();
      // The child owns its own listener: spawnSync blocks this process's event
      // loop, so a server living here could never accept the child's socket.
      const control = spawnSync(process.execPath, ["-e", `
        const http = require("node:http");
        const srv = http.createServer((q, r) => { r.statusCode = 204; r.end(); });
        srv.listen(0, "127.0.0.1", () => {
          const url = "http://127.0.0.1:" + srv.address().port + "/";
          const go = (label, opts) => new Promise((done) => {
            http.get(url, opts, (r) => { r.resume(); console.log(label, r.statusCode); done(); })
              .on("error", (e) => { console.log(label, "err", e.code); done(); });
          });
          go("default", {}).then(() => go("private", { agent: new http.Agent() })).then(() => srv.close());
        });
      `], {
        encoding: "utf8",
        env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
        timeout: 10_000,
      });
      expect(control.stdout).toContain("default err ECONNREFUSED");
      expect(control.stdout).toContain("private 204");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("validates bounded flow formats before they are stored", () => {
    expect(validatePlaywrightSource("")).toContain("required");
    expect(validateMaestroYAML("appId: com.example\n---\n- launchApp")).toBeNull();
    expect(validateMaestroYAML("---\n- launchApp")).toContain("appId");
    expect(validateMaestroYAML("appId: com.example\n- launchApp")).toContain("separator");
  });
});
