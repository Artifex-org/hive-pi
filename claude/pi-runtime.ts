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

export function loadPinnedPi(piBin: string, agentDir: string): Promise<PinnedPi> {
	loaded ??= (async () => {
		const root = piPackageRoot(piBin);
		const pi = (await import(pathToFileURL(entryOf(root)).href)) as {
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
	})();
	return loaded;
}
