/**
 * Make `bash` resolvable, whatever the host.
 *
 * The repo gate spawns `bash -lc <check>`. Any test that exercises the gate is
 * therefore environment-dependent by default: it can pass on the workstation and
 * behave differently wherever bash is absent.
 *
 * As of HIV-1238 the CI **test** step runs on `node:22.19.0` (Debian), which has
 * a real bash — so in CI this shim is now a no-op and the suites exercise the
 * genuine interpreter. It is kept for any environment that still lacks bash
 * (alpine-based images are still used for the typecheck and config-check steps),
 * and because the failure it prevents is subtle.
 *
 * That is not hypothetical — it bit twice. First when the gate characterization
 * suite was written (it would have passed locally and inverted in CI, because
 * `spawn` ENOENT resolves `ok:false` and even the *passing*-gate cases would
 * have injected). Then again when the gate learned to probe for bash and
 * correctly returned `skip` in CI, breaking a `/agenda stop` test that had been
 * silently relying on the ENOENT path to produce an injection.
 *
 * So every test that needs a working gate calls this. Where bash genuinely
 * exists it is left alone; otherwise a POSIX-`sh` shim goes first on `PATH`, so
 * the real spawn path is still exercised and only the interpreter differs.
 * Every `check` command in this suite is plain POSIX.
 *
 * vitest runs each test FILE in its own worker, so this must be called per file
 * — a shim installed by one suite is invisible to the next.
 */

import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export function bashOnPath(): boolean {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.some((dir) => dir && existsSync(join(dir, "bash")));
}

/** Idempotent: safe to call from several `beforeAll`s in one worker. */
export function ensureBash(): void {
	if (bashOnPath()) return;

	const shimDir = mkdtempSync(join(tmpdir(), "hive-pi-bashshim-"));
	const shim = join(shimDir, "bash");
	// Invoked as `bash -lc "<command>"`, so the command is $2.
	writeFileSync(shim, '#!/bin/sh\nexec /bin/sh -c "$2"\n');
	chmodSync(shim, 0o755);
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
}
