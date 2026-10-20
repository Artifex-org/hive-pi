import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * A fake query's stdin message. A rebuilt tool-result continuation must send none: the CLI
 * resumes the turn its seed ends in. For such a query this proves the prompt stays silent,
 * rather than merely not reading it.
 */
export async function firstInput(request: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Promise<SDKUserMessage | undefined> {
	const next = request.prompt[Symbol.asyncIterator]().next();
	if (request.options.env?.CLAUDE_CODE_RESUME_INTERRUPTED_TURN !== "1") return (await next).value;
	let sent = false;
	void next.then(result => { sent = !result.done; });
	for (let tick = 0; tick < 20 && !sent; tick++) await Promise.resolve();
	if (sent) throw new Error("a resumed tool-result query sent stdin input");
	return undefined;
}
