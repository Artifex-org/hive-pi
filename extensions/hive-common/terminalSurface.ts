import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The terminal an agent's shell commands run on, as a surface a human can
 * attach to. Sibling of `browserSurface.ts` and validated the same way, because
 * the risk is the same: this code writes files and opens FIFOs at paths that
 * arrive in the environment.
 *
 * Two things differ from the browser config, both forced by the contract rather
 * than chosen — see `terminalSurfaceID` below, and the absence of any
 * `latest-*` image path (a terminal publishes bytes, not screenshots).
 */
export interface TerminalSurfaceConfig {
  dir: string;
  frameFIFO: string;
  controlFIFO: string;
  manifest: string;
  lease: string;
  launchID: string;
  /** The surface id to PUT under — NOT the launch id. See below. */
  surfaceID: string;
}

function expectedPath(dir: string, name: string): string {
  return path.join(dir, name);
}

/**
 * A stable UUID derived from the launch id, distinct from it.
 *
 * THE BROWSER PUBLISHER USES THE LAUNCH ID AS THE SURFACE ID. A terminal
 * surface in the same launch cannot do that: both would PUT to
 * `/surfaces/{launchID}`, and the server's `sequence <= EXCLUDED.sequence`
 * monotonicity plus `ReapTerminalAgentSessionSurface` would make the two
 * publishers alternately reject and tombstone each other's rows. The failure
 * would look like flapping, not like a collision.
 *
 * UUIDv5-shaped (SHA-1 of a fixed namespace and the launch id, with the version
 * and variant bits set), so it is:
 *   - STABLE across restarts, which sequence monotonicity and the TTL reaper
 *     both depend on;
 *   - a valid UUID for the server's `parseUUID`, and version 5 is inside the
 *     `[1-5]` the producer-side regex accepts.
 *
 * Requires no server change and no new dependency.
 */
export function terminalSurfaceID(launchID: string): string {
  // A fixed namespace so the mapping is reproducible; any constant would do,
  // this one is arbitrary and must never change.
  const NAMESPACE = "hive-terminal-surface";
  const h = createHash("sha1").update(NAMESPACE).update(launchID).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The node injects these paths. Validate the whole tuple anyway: a sibling
 * extension may mutate process.env, and a bad path here is one this process
 * would then write to.
 */
export function terminalSurfaceConfig(env: NodeJS.ProcessEnv): TerminalSurfaceConfig | null {
  const dir = env.HIVE_TERMINAL_SURFACE_DIR?.trim();
  const frameFIFO = env.HIVE_TERMINAL_FRAME_FIFO?.trim();
  const controlFIFO = env.HIVE_TERMINAL_CONTROL_FIFO?.trim();
  const manifest = env.HIVE_TERMINAL_SURFACE_MANIFEST?.trim();
  const launchID = env.HIVE_LAUNCH_ID?.trim();
  if (!dir || !frameFIFO || !controlFIFO || !manifest || !launchID || !path.isAbsolute(dir)) return null;
  const resolved = path.resolve(dir);
  const scratchRoot = path.resolve(os.homedir(), ".hive", "scratch");
  if (!resolved.startsWith(scratchRoot + path.sep)) return null;
  if (
    path.resolve(frameFIFO) !== expectedPath(resolved, "frames.fifo") ||
    path.resolve(controlFIFO) !== expectedPath(resolved, "control.fifo") ||
    path.resolve(manifest) !== expectedPath(resolved, "manifest.json")
  ) {
    return null;
  }
  try {
    // Checked lexically AND through realpath: a symlink whose text sits under
    // the scratch root can still point anywhere.
    const realScratch = fs.realpathSync(scratchRoot);
    const realDir = fs.realpathSync(resolved);
    if (!realDir.startsWith(realScratch + path.sep) || fs.lstatSync(resolved).isSymbolicLink()) return null;
    if (!fs.lstatSync(frameFIFO).isFIFO() || !fs.lstatSync(controlFIFO).isFIFO()) return null;
    // Group- or world-accessible means another local user could read the
    // terminal stream, which may carry a passphrase being typed.
    if ((fs.statSync(resolved).mode & 0o077) !== 0) return null;
  } catch {
    return null;
  }
  const id = launchID.slice(0, 64);
  return {
    dir: resolved,
    frameFIFO,
    controlFIFO,
    manifest,
    lease: expectedPath(resolved, "lease.json"),
    launchID: id,
    surfaceID: terminalSurfaceID(id),
  };
}
