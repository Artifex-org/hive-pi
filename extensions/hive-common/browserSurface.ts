import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BrowserSurfaceConfig {
  dir: string;
  frameFIFO: string;
  controlFIFO: string;
  manifest: string;
  lease: string;
  latestWebImage: string;
  latestWebMetadata: string;
  launchID: string;
}

function expectedPath(dir: string, name: string): string {
  return path.join(dir, name);
}

// The node injects these paths. Validate the whole tuple anyway: a sibling
// extension may mutate process.env, and this code writes image/manifest files.
export function browserSurfaceConfig(env: NodeJS.ProcessEnv): BrowserSurfaceConfig | null {
  const dir = env.HIVE_BROWSER_SURFACE_DIR?.trim();
  const frameFIFO = env.HIVE_BROWSER_FRAME_FIFO?.trim();
  const controlFIFO = env.HIVE_BROWSER_CONTROL_FIFO?.trim();
  const manifest = env.HIVE_BROWSER_SURFACE_MANIFEST?.trim();
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
    const realScratch = fs.realpathSync(scratchRoot);
    const realDir = fs.realpathSync(resolved);
    if (!realDir.startsWith(realScratch + path.sep) || fs.lstatSync(resolved).isSymbolicLink()) return null;
    if (!fs.lstatSync(frameFIFO).isFIFO() || !fs.lstatSync(controlFIFO).isFIFO()) return null;
    if ((fs.statSync(resolved).mode & 0o077) !== 0) return null;
  } catch {
    return null;
  }
  return {
    dir: resolved,
    frameFIFO,
    controlFIFO,
    manifest,
    lease: expectedPath(resolved, "lease.json"),
    latestWebImage: expectedPath(resolved, "latest-web.jpg"),
    latestWebMetadata: expectedPath(resolved, "latest-web.json"),
    launchID: launchID.slice(0, 64),
  };
}
