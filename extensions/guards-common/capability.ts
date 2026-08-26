/**
 * Tool capability declarations, and the guard that acts on them (wave 5).
 *
 * ## Why this exists
 *
 * `guards-bridge` enforces on tool NAME — it matches `bash`, `edit` and `write`
 * and lets everything else through. Of 47 registered tools, exactly ONE called
 * the guard before this module, and it was added the day before. Every new tool
 * that writes or executes has been, by default, ungoverned.
 *
 * pi cannot help: `ToolDefinition` (0.84) has `name`, `label`, `description`,
 * `promptSnippet`, `promptGuidelines`, `parameters`, `constrainedSampling`,
 * `renderShell`, `prepareArguments`, `executionMode`, `execute` and the two
 * renderers. There is no field expressing mutation, side effects or required
 * permission, and `ToolInfo` — the only derived view a policy layer could read —
 * carries even less. So the declaration has to be ours.
 *
 * ## The rule this encodes
 *
 * **A tool that writes or executes must declare it. Guards are not inherited.**
 * The conformance test (`test/tool-capability.test.ts`) fails on any registered
 * tool that neither declares a capability nor sits on a reviewed read-only
 * allowlist, so the next tool cannot be quietly ungoverned — the allowlist diff
 * is the review surface.
 *
 * ## Stateless on purpose
 *
 * pi builds a fresh jiti instance per extension with `moduleCache: false`, so
 * two importers of this module get two separate instances. Everything here is
 * pure or reads the filesystem per call; nothing is cached at module scope,
 * because that state would silently not be shared.
 */

import type { TSchema } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { decide, realProbe } from "./worktree-guard.ts";

/**
 * What a tool does that policy cares about.
 *
 * `writes` names the *parameters* holding paths, so the wrapper can guard them
 * without knowing the tool. `executes` is a declaration only: there is no argv
 * policy engine here, and inventing one would be a second guard competing with
 * the bash hook. It exists so the conformance test can see the tool is
 * accounted for, and so a reader can find every execution site by grepping.
 */
export interface ToolCapability {
	/** Parameter names whose values are paths this tool may write. */
	writes?: string[];
	/**
	 * Paths this tool writes that are DERIVED rather than passed in — e.g. a
	 * note whose location is built from a slug and a name. Given the call's
	 * params and cwd, return what it is about to write.
	 */
	writesResolved?: (params: Record<string, unknown>, cwd: string | undefined) => string[];
	/** True when the tool runs a subprocess. Declaration, not enforcement. */
	executes?: boolean;
	/** Why this tool is exempt from path guarding despite writing somewhere. */
	writesExemptBecause?: string;
}

export interface GuardBlock {
	blocked: string[];
	reason: string;
}

/**
 * Guard a set of target paths. Returns null when every one is allowed.
 *
 * Moved here from `lens/refactor.ts`, which was the first (and for one day the
 * only) caller.
 */
export function guardTargets(files: readonly string[], toolLabel: string): GuardBlock | null {
	const blocked: string[] = [];
	const reasons: string[] = [];
	for (const file of files) {
		if (!file) continue;
		const verdict = decide(file, toolLabel, realProbe);
		if (verdict.kind === "block") {
			blocked.push(file);
			reasons.push(verdict.reason);
		}
	}
	if (blocked.length === 0) return null;
	return { blocked, reason: reasons[0] };
}

/**
 * Guard the working directory a child agent is about to be spawned into.
 *
 * This is the highest-value check in the module, because it is the ONLY one
 * that exists for delegated work. Measured: a worker is spawned with
 * `--no-extensions`, which strips `guards-bridge` along with everything else, so
 * a worker has **no worktree guard at all**. A synthetic repo carrying
 * `.worktree-guard` — for which `decide()` returns `block` — was written to
 * successfully by a worker-shaped pi.
 *
 * So a writer-capable role delegated into a guarded checkout would edit it
 * freely, and the parent is the last place that can say no. Called where the
 * writer lock is already acquired, so the two protections sit together.
 *
 * Read-only roles are not checked: they cannot write, and refusing to *read* a
 * pull-only worktree would break ordinary review work.
 */
export function guardWorkerCwd(cwd: string, toolLabel: string): GuardBlock | null {
	// A directory, not a file: `decide()` locates the repo from the parent of the
	// path it is given, so a bare directory would be judged by its PARENT's
	// worktree. Naming a file inside it is what makes the verdict about `cwd`.
	return guardTargets([`${cwd.replace(/\/+$/, "")}/.pi-guard-probe`], toolLabel);
}

/** The message a refused spawn returns — names the cause and the remedy. */
export function workerCwdRefusal(role: string, cwd: string, block: GuardBlock): string {
	return [
		`Refusing to run writer-capable role "${role}" in a protected worktree.`,
		"",
		block.reason,
		"",
		`A delegated worker runs without the guard extensions the interactive session has, so this is the ` +
			`only point at which it can be refused. Re-run it in a task worktree — ` +
			`\`gwq add -b <name>\`, or \`gwq add -b <name> <writable-dir>/<name>\` in a sandbox, where gwq's ` +
			`default basedir is the read-only shared worktree root — or delegate a read-only role if you ` +
			`only need to look at ${cwd}.`,
	].join("\n");
}

/**
 * Register a tool WITH its capability declaration.
 *
 * Two jobs, and the second is the one that compounds:
 *
 * 1. If the tool declares `writes`, its declared path parameters are guarded
 *    before `execute` runs. The tool does not have to remember; the wrapper
 *    cannot forget.
 * 2. The declaration is attached to the registered definition, so the
 *    conformance test can SEE that a tool was considered. That is what makes
 *    "new tool → ungoverned by default" fail in CI instead of in production.
 *
 * `executes` is a declaration only. There is deliberately no argv policy engine
 * here: that would be a second guard competing with the bash hook, and the
 * house has one bad experience per competing-guidance already.
 */
export function registerGuardedTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
	pi: Pick<ExtensionAPI, "registerTool">,
	// pi's own ToolDefinition, so a caller keeps the contextual typing of its
	// `execute` params, plus OUR capability field — which pi has no concept of.
	definition: ToolDefinition<TParams, TDetails, TState> & { capability: ToolCapability },
): void {
	const { capability, execute, ...rest } = definition as ToolDefinition<TParams, TDetails, TState> & {
		capability: ToolCapability;
	};
	const writes = capability.writes ?? [];
	const resolver = capability.writesResolved;

	const guarded =
		writes.length === 0 && !resolver
			? execute
			: (async (...args: unknown[]) => {
					// pi's execute signature is (id, params, signal, onUpdate, ctx).
					const params = args[1] as Record<string, unknown> | undefined;
					const ctx = args[4] as { cwd?: string } | undefined;
					const targets: string[] = [];
					for (const key of writes) {
						const value = params?.[key];
						if (typeof value === "string" && value) targets.push(resolveAgainst(ctx?.cwd, value));
						else if (Array.isArray(value)) {
							for (const item of value) {
								if (typeof item === "string" && item) targets.push(resolveAgainst(ctx?.cwd, item));
							}
						}
					}
					if (resolver) {
						for (const path of resolver(params ?? {}, ctx?.cwd)) {
							if (path) targets.push(resolveAgainst(ctx?.cwd, path));
						}
					}
					const block = guardTargets(targets, definition.name);
					if (block) {
						return {
							content: [
								{
									type: "text",
									text:
										`Refusing to write ${block.blocked.length} guarded path(s).\n\n${block.reason}`,
								},
							],
							details: {},
							isError: true,
						};
					}
					return (execute as unknown as (...a: unknown[]) => unknown)(...args);
				});

	// Cast at the boundary: `capability` is OUR field, not part of pi's
	// ToolDefinition (which has no capability concept at all — that is why this
	// module exists). pi ignores what it does not know; the conformance test
	// reads it back off the registered definition.
	pi.registerTool({ ...rest, capability, execute: guarded } as never);
}

/** Relative paths are resolved against the tool's cwd — the guard judges where
 *  bytes land, and a bare "foo.ts" lands in the session's directory. */
function resolveAgainst(cwd: string | undefined, path: string): string {
	if (path.startsWith("/")) return path;
	return cwd ? `${cwd.replace(/\/+$/, "")}/${path}` : path;
}
