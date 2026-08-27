import { describe, expect, it } from "vitest";
import opmodeExtension from "../extensions/opmode/index.ts";
import { createFakePi } from "./fake-pi.ts";

type Execute = (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: { hive_widget?: { spec?: { stage?: string } } } }>;

function evidence(pi: ReturnType<typeof createFakePi>): Execute {
	const tool = pi.tools.find((entry) => entry.name === "bugfix_evidence");
	if (!tool) throw new Error("bugfix_evidence was not registered");
	return tool.definition.execute as Execute;
}

async function result(pi: ReturnType<typeof createFakePi>, id: string, name: string, isError: boolean) {
	await pi.emit({ type: "tool_result", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: isError ? "failed" : "passed" }] });
}

describe("bugfix evidence protocol", () => {
	it("requires distinct failing and passing runs bound by one stable reproduction key", async () => {
		const pi = createFakePi();
		opmodeExtension(pi.api);
		await pi.emit({ type: "session_start", reason: "startup" });
		await pi.runCommand("mode", "bugfix");
		const record = evidence(pi);

		await result(pi, "fail-1", "bash", true);
		expect((await record("e1", { phase: "reproduce", tool_call_id: "fail-1", reproduction_key: "targeted-test" })).details.hive_widget?.spec?.stage).toBe("hypothesize");
		expect((await record("e2", { phase: "hypothesize", tool_call_id: "fail-1", hypothesis: "state leaks" })).details.hive_widget?.spec?.stage).toBe("instrument");
		await result(pi, "instrument-1", "bash", false);
		await record("e3", { phase: "instrument", tool_call_id: "instrument-1" });
		await record("e4", { phase: "confirm", tool_call_id: "instrument-1", hypothesis: "state leaks" });

		const sameCall = await record("e5", { phase: "reverify", tool_call_id: "fail-1", reproduction_key: "targeted-test" });
		expect(sameCall.details.hive_widget).toBeUndefined();
		await result(pi, "pass-1", "bash", false);
		expect((await record("e6", { phase: "reverify", tool_call_id: "pass-1", reproduction_key: "targeted-test" })).details.hive_widget?.spec?.stage).toBe("done");
	});
});
