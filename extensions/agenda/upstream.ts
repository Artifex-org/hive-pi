/**
 * Forwarding upstream results into a dependent node's prompt.
 *
 * `needs` used to ORDER execution and nothing else: a reconciler declared
 * `needs: ["contract", "evidence"]`, was dispatched with only its own prompt,
 * reported "No independent worker findings were supplied to reconcile", and
 * then reviewed whatever unrelated work it found in the repo (papercuts
 * 2026-10-01..03, five runs). The orchestration-reconciler role prompt already
 * says "The prompt contains the prior workers' findings as data" — this is the
 * code that makes that sentence true.
 *
 * Fenced as data, placed before the task, bounded, never cut silently. A
 * worker is a fresh `pi` spawned
 * `--no-extensions` with tools like `read, grep, find, ls`, so an
 * `artifact://N` ref means nothing to it: a result too large to inline is
 * spilled through the session's artifact store and handed over as a FILE PATH
 * it can `read`, with the tail inline and the true size stated.
 *
 * The scheduler stays pure: `nextBatch` attaches the resolved values
 * (`Dispatch.inputs`); rendering — the only part that may write a file —
 * happens here, called by the executor right before a dispatch is spawned.
 * Inputs never enter the work id, so resume still matches on the node itself.
 */

import { spill } from "../artifacts/store.ts";
import { FENCED_DATA_NOTE, fence, nonceFor } from "../harness/fence.ts";
import type { Dispatch } from "./plan-graph.ts";

/** The most of ONE upstream result inlined; above it the result is spilled. */
export const INLINE_INPUT_BYTES = 8 * 1024;

/** The most inlined across ALL of a node's inputs; later inputs spill once it is spent. */
export const INLINE_INPUTS_TOTAL_BYTES = 24 * 1024;

/** How much of a spilled result is still shown inline (its tail — reports conclude last). */
export const SPILLED_PREVIEW_BYTES = 2 * 1024;

/**
 * The most spilled-result PREVIEW across all of a node's inputs. Past it a
 * spilled input is handed over by path alone. The prompt is one argv argument
 * to a non-durable worker, and Linux caps one argument at 128KiB: 24KB inline
 * plus 8KB of previews plus one line per input keeps far under it.
 */
export const SPILLED_PREVIEWS_TOTAL_BYTES = 8 * 1024;

/** The artifact kind, i.e. the file suffix: `<id>.orchestrate-input.log`. */
const INPUT_KIND = "orchestrate-input";

/** The fence label around each forwarded body. */
const INPUT_LABEL = "UPSTREAM RESULT";

export interface UpstreamInput {
	/** The ref as the plan wrote it (`contract`, `a.verdict`), or the node a barrier joined. */
	ref: string;
	value: unknown;
}

/** One result as text: strings as written, anything structured as JSON. */
export function renderInputValue(value: unknown): string {
	if (value === undefined) return "(no result recorded)";
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

/**
 * The inputs block of a node's prompt: each upstream result FENCED as data
 * (harness/fence.ts) under its own heading, the block explicitly closed. It is
 * placed BEFORE the authored task (`promptWithInputs`), so an upstream output
 * that says "## Your task (revised)" can neither pass for structure nor take
 * the recency position from the real task.
 *
 * `inputsDir` is where a result too large to inline is written. When a result
 * must spill and cannot — no directory, a full store, a failed write — this
 * THROWS rather than truncating: the executor fails the node with that
 * message instead of dispatching a worker missing its inputs.
 *
 * Computed ONCE per node, not per dispatch: a fanout's N items share the same
 * `needs`, and rendering per item would write N identical spill files (200
 * items alone would fill the session's artifact store).
 */
export function renderInputsSection(inputs: readonly UpstreamInput[], inputsDir: string | undefined): string {
	const bodies = inputs.map((input) => renderInputValue(input.value));
	const nonce = nonceFor(bodies);
	const sections: string[] = [];
	let inlined = 0;
	let previewed = 0;
	inputs.forEach((input, index) => {
		const body = bodies[index];
		const bytes = Buffer.byteLength(body, "utf8");
		if (bytes <= INLINE_INPUT_BYTES && inlined + bytes <= INLINE_INPUTS_TOTAL_BYTES) {
			inlined += bytes;
			sections.push(`### ${input.ref}\n${fence(INPUT_LABEL, `ref=${input.ref}`, body, nonce)}`);
			return;
		}
		if (!inputsDir) {
			throw new Error(
				`upstream result "${input.ref}" is ${bytes} bytes, over the ${INLINE_INPUT_BYTES}-byte inline limit, and there is no inputs directory to write it to`,
			);
		}
		const stored = spill(body, { dir: inputsDir, kind: INPUT_KIND, previewBytes: SPILLED_PREVIEW_BYTES });
		if (!stored.file) {
			// `spill` states why (store full, write failed) on its first line.
			throw new Error(
				`upstream result "${input.ref}" (${bytes} bytes) could not be written for forwarding: ${stored.text.slice(0, stored.text.indexOf("\n"))}`,
			);
		}
		const holds =
			stored.storedBytes < bytes
				? `${bytes} bytes; the file holds only the last ${stored.storedBytes} of ${bytes} bytes (the store's per-file cap) — written to ${stored.file}`
				: `all ${bytes} bytes, written in full to ${stored.file}`;
		const tail = stored.text.slice(stored.text.indexOf("\n") + 1);
		const tailBytes = Buffer.byteLength(tail, "utf8");
		if (previewed + tailBytes <= SPILLED_PREVIEWS_TOTAL_BYTES) {
			previewed += tailBytes;
			sections.push(
				`### ${input.ref}\n[Too large to inline: ${holds} — read that file. Its last ${tailBytes} bytes follow.]\n` +
					fence(INPUT_LABEL, `ref=${input.ref} part=tail`, tail, nonce),
			);
		} else {
			sections.push(`### ${input.ref}\n[Too large to inline: ${holds} — read that file. No preview: this prompt's preview budget is spent.]`);
		}
	});

	return [
		"## Results from the nodes this one needs",
		`The final outputs of the upstream nodes named in this node's \`needs\`, forwarded by the orchestrator. ${FENCED_DATA_NOTE}`,
		"",
		sections.join("\n\n"),
		"",
		"## End of upstream results",
	].join("\n");
}

/**
 * The prompt a dispatch runs with. With inputs, they come FIRST and the
 * authored task LAST under its own heading — the task keeps the recency
 * position, and nothing in an input can follow it.
 */
export function promptWithInputs(prompt: string, section: string | undefined): string {
	return section ? `${section}\n\n## Your task\n${prompt}` : prompt;
}
