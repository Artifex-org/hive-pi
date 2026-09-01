import { describe, expect, it } from "vitest";
import { sourceFor, validateMaestroYAML, validatePlaywrightSource } from "../extensions/flows/register.ts";

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

  it("validates bounded flow formats before they are stored", () => {
    expect(validatePlaywrightSource("")).toContain("required");
    expect(validateMaestroYAML("appId: com.example\n---\n- launchApp")).toBeNull();
    expect(validateMaestroYAML("---\n- launchApp")).toContain("appId");
    expect(validateMaestroYAML("appId: com.example\n- launchApp")).toContain("separator");
  });
});
