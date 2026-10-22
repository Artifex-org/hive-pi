/**
 * The pinned pi's own runtime, for the two things the adapter must not
 * reimplement: the role-file frontmatter parser and the conversation
 * serializer the advisor reads.
 *
 * `@earendil-works/pi-coding-agent` does not resolve from this checkout on a
 * node (the adapter runs under plain node, outside pi). The launch pins a pi
 * binary, though — `HIVE_PI_BIN`, a symlink into that package's install — so
 * the package is found from there and its PUBLIC entry (`exports["."]`) is
 * imported by absolute path. Its own dependencies resolve from its own
 * install. Loaded on first use only (≈0.4 s): the MCP server's subagent and
 * advisor tools and the brief need it; no hook does.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RolesRuntime } from "../extensions/harness/roles-core.ts";

const PACKAGE = "@earendil-works/pi-coding-agent";

export interface PinnedPi {
	roles: RolesRuntime;
	/** pi's `serializeConversation`: `[User]: … / [Assistant]: … / [Tool result]: …`. */
	serializeConversation(messages: readonly unknown[]): string;
	/** The package root, for messages. */
	root: string;
}

/** The pi package root that owns `piBin`, walking up from its real path. */
export function piPackageRoot(piBin: string): string {
	let dir = dirname(realpathSync(piBin));
	for (;;) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
			if (name === PACKAGE) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`${piBin} is not inside an installed ${PACKAGE} package`);
		dir = parent;
	}
}

function entryOf(root: string): string {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		exports?: { "."?: { import?: unknown } | string };
		main?: unknown;
	};
	const dot = manifest.exports?.["."];
	const entry = typeof dot === "string" ? dot : typeof dot?.import === "string" ? dot.import : typeof manifest.main === "string" ? manifest.main : null;
	if (!entry) throw new Error(`${root}/package.json names no import entry`);
	return join(root, entry);
}

let loaded: Promise<PinnedPi> | undefined;

/**
 * The pinned pi, loaded once. A FAILED load is not kept: the harness repairs a
 * broken pi by swapping `bin/pi` onto a new graph (`hive-agent workstation
 * harness install`), and the next call resolves that new path. Keeping the
 * rejection made the advisor and subagent tools fail for the rest of the
 * session even after the repair.
 */
export function loadPinnedPi(piBin: string, agentDir: string): Promise<PinnedPi> {
	if (!loaded) {
		const attempt = load(piBin, agentDir);
		loaded = attempt;
		attempt.catch(() => { if (loaded === attempt) loaded = undefined; });
	}
	return loaded;
}

async function load(piBin: string, agentDir: string): Promise<PinnedPi> {
	const root = piPackageRoot(piBin);
	let module: unknown;
	try { module = await import(pathToFileURL(entryOf(root)).href); }
	catch (error) {
		// A dependency that floated away from pi's own (pi-codemode 1.3.0 under pi 1.1.0) breaks this
		// unbundled entry while the bundled CLI keeps working, so name the install, not just the symbol.
		throw new Error(`the pinned pi at ${root} cannot be imported (${error instanceof Error ? error.message : String(error)}); ` +
			"repair the harness with `hive-agent workstation harness install`", { cause: error });
	}
	const pi = module as {
		parseFrontmatter?: (content: string) => { frontmatter: Record<string, unknown>; body: string };
		serializeConversation?: (messages: readonly unknown[]) => string;
		CONFIG_DIR_NAME?: unknown;
	};
	const { parseFrontmatter, serializeConversation, CONFIG_DIR_NAME } = pi;
	if (typeof parseFrontmatter !== "function" || typeof serializeConversation !== "function" || typeof CONFIG_DIR_NAME !== "string") {
		throw new Error(`the pinned pi at ${root} does not export parseFrontmatter, serializeConversation and CONFIG_DIR_NAME`);
	}
	return {
		root,
		serializeConversation,
		roles: {
			parseFrontmatter,
			// The LEASED store, never pi's own default (~/.pi/agent).
			agentDir: () => agentDir,
			configDirName: CONFIG_DIR_NAME,
		},
	};
}
