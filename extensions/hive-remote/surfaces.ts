import fs from "node:fs";
import { browserSurfaceConfig, type BrowserSurfaceConfig } from "../hive-common/browserSurface.ts";
import { terminalSurfaceConfig, type TerminalSurfaceConfig } from "../hive-common/terminalSurface.ts";
import { request, withTimeout, type HiveAuth } from "../hive-common/http.ts";

const MAX_METADATA_BYTES = 16 << 10;
const MAX_IMAGE_BYTES = 2 << 20;
const STALE_AFTER_MS = 10_000;

interface WebSnapshotMetadata {
  version: 1;
  sequence: number;
  content_type: "image/jpeg" | "image/png" | "image/webp";
  size_bytes: number;
  url: string;
  title: string;
  width: number;
  height: number;
  updated_at: number;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function readWebSnapshot(config: BrowserSurfaceConfig): { metadata: WebSnapshotMetadata; image: Buffer } | null {
  try {
    const metadataStat = fs.lstatSync(config.latestWebMetadata);
    const imageStat = fs.lstatSync(config.latestWebImage);
    if (
      !metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > MAX_METADATA_BYTES ||
      !imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size < 1 || imageStat.size > MAX_IMAGE_BYTES ||
      (metadataStat.mode & 0o077) !== 0 || (imageStat.mode & 0o077) !== 0
    ) {
      return null;
    }
    const metadata = JSON.parse(fs.readFileSync(config.latestWebMetadata, "utf8")) as Partial<WebSnapshotMetadata>;
    if (
      metadata.version !== 1 || !Number.isInteger(metadata.sequence) || Number(metadata.sequence) < 0 ||
      !["image/jpeg", "image/png", "image/webp"].includes(metadata.content_type ?? "") ||
      metadata.size_bytes !== imageStat.size || typeof metadata.url !== "string" || metadata.url.length > 4096 ||
      typeof metadata.title !== "string" || metadata.title.length > 256 ||
      !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) ||
      Number(metadata.width) < 0 || Number(metadata.width) > 16384 ||
      Number(metadata.height) < 0 || Number(metadata.height) > 16384 ||
      typeof metadata.updated_at !== "number"
    ) {
      return null;
    }
    const image = fs.readFileSync(config.latestWebImage);
    if (image.length !== metadata.size_bytes) return null;
    return { metadata: metadata as WebSnapshotMetadata, image };
  } catch {
    return null;
  }
}

async function putSnapshot(
  auth: HiveAuth,
  sessionID: string,
  surfaceID: string,
  snapshot: { metadata: WebSnapshotMetadata; image: Buffer },
): Promise<boolean> {
  try {
    const res = await withTimeout(5_000, (signal) => fetch(
      `${auth.url}/api/v1/agent-sessions/${encodeURIComponent(sessionID)}/surfaces/${surfaceID}/snapshot?sequence=${snapshot.metadata.sequence}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": snapshot.metadata.content_type,
        },
        body: new Uint8Array(snapshot.image),
        signal,
      },
    ));
    return res.ok;
  } catch {
    return false;
  }
}

export class BrowserSurfacePublisher {
  private config: BrowserSurfaceConfig | null;
  private uploadedSequence = -1;
  private lastState = "";
  private sending = false;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = browserSurfaceConfig(env);
    if (this.config && !uuid(this.config.launchID)) this.config = null;
  }

  async tick(auth: HiveAuth | null, sessionID: string | null, now = Date.now()): Promise<void> {
    if (!this.config || !auth || !sessionID || this.sending) return;
    const snapshot = readWebSnapshot(this.config);
    if (!snapshot) return;
    const stale = now - snapshot.metadata.updated_at > STALE_AFTER_MS;
    const state = stale ? "stale" : "ready";
    if (stale && this.lastState === "stale") return;
    this.sending = true;
    try {
      const metadataResult = await request(
        auth,
        "PUT",
        `/agent-sessions/${encodeURIComponent(sessionID)}/surfaces/${this.config.launchID}`,
        {
          kind: "browser",
          state,
          capabilities: ["snapshot", "stream", "semantic_input", "raw_input"],
          sensitivity: "credential_possible",
          title: snapshot.metadata.title,
          url: snapshot.metadata.url,
          width: snapshot.metadata.width,
          height: snapshot.metadata.height,
          sequence: snapshot.metadata.sequence,
          ttl_seconds: 30,
        },
      );
      if (!metadataResult.ok) {
        if (stale && metadataResult.status === 409) {
          this.lastState = "stale";
          this.uploadedSequence = -1;
        }
        return;
      }
      this.lastState = state;
      if (stale) {
        // Stop extending the surface TTL after one stale transition. If the
        // browser later revives without changing sequence, force one fresh
        // image upload because the expiry reaper may have deleted the old one.
        this.uploadedSequence = -1;
        return;
      }
      if (snapshot.metadata.sequence > this.uploadedSequence) {
        if (await putSnapshot(auth, sessionID, this.config.launchID, snapshot)) {
          this.uploadedSequence = snapshot.metadata.sequence;
        }
      }
    } finally {
      this.sending = false;
    }
  }

  async end(auth: HiveAuth | null, sessionID: string | null): Promise<void> {
    if (!this.config || !auth || !sessionID || this.lastState === "ended") return;
    const snapshot = readWebSnapshot(this.config);
    if (!snapshot) return;
    this.lastState = "ended";
    await request(auth, "PUT", `/agent-sessions/${encodeURIComponent(sessionID)}/surfaces/${this.config.launchID}`, {
      kind: "browser",
      state: "ended",
      capabilities: ["snapshot", "stream", "semantic_input", "raw_input"],
      sensitivity: "credential_possible",
      title: snapshot.metadata.title,
      url: snapshot.metadata.url,
      width: snapshot.metadata.width,
      height: snapshot.metadata.height,
      sequence: snapshot.metadata.sequence + 1,
      ttl_seconds: 0,
    });
  }
}

const TERMINAL_MAX_MANIFEST_BYTES = 16 << 10;

interface TerminalManifest {
  version: 1;
  kind: "terminal";
  state: "ready" | "ended" | "error";
  rows: number;
  cols: number;
  updated_at: number;
}

/**
 * Read the terminal manifest the in-sandbox bridge maintains.
 *
 * A terminal has no image and no `latest-*.json` — the manifest IS the state,
 * so the same lstat/size/symlink guards apply to it directly.
 */
export function readTerminalManifest(config: TerminalSurfaceConfig): TerminalManifest | null {
  try {
    const stat = fs.lstatSync(config.manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > TERMINAL_MAX_MANIFEST_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(config.manifest, "utf8")) as Partial<TerminalManifest>;
    if (value.version !== 1 || value.kind !== "terminal") return null;
    if (value.state !== "ready" && value.state !== "ended" && value.state !== "error") return null;
    if (!Number.isInteger(value.updated_at)) return null;
    const rows = Number.isInteger(value.rows) ? Number(value.rows) : 0;
    const cols = Number.isInteger(value.cols) ? Number(value.cols) : 0;
    if (rows < 0 || rows > 16384 || cols < 0 || cols > 16384) return null;
    return { ...(value as TerminalManifest), rows, cols };
  } catch {
    return null;
  }
}

/**
 * Advertise the agent's terminal in Hive so the desktop app can find it.
 *
 * Mirrors BrowserSurfacePublisher's cadence and stale/ended discipline. Two
 * differences, both forced:
 *
 *  - IT DECLARES NO `snapshot` CAPABILITY, so it never uploads bytes. The
 *    server sniffs snapshot content types and accepts only PNG/JPEG/WebP, and
 *    a terminal has no image. That is a feature rather than a limitation: with
 *    no snapshot capability the upload endpoint refuses outright, so raw ANSI
 *    that may contain a passphrase has no route into object storage. The web
 *    view gets the already-stripped text through the existing tool_update
 *    frames instead.
 *  - IT PUTS UNDER `config.surfaceID`, not the launch id. The browser publisher
 *    owns that row; two publishers on one row would tombstone each other.
 */
export class TerminalSurfacePublisher {
  private config: TerminalSurfaceConfig | null;
  private sequence = 0;
  private lastState = "";
  private sending = false;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = terminalSurfaceConfig(env);
    if (this.config && !uuid(this.config.surfaceID)) this.config = null;
  }

  private body(manifest: TerminalManifest, state: string, sequence: number, ttl: number) {
    return {
      kind: "terminal",
      state,
      capabilities: ["stream", "raw_input"],
      // Someone may type a passphrase into this terminal.
      sensitivity: "credential_possible",
      title: "Agent terminal",
      width: manifest.cols,
      height: manifest.rows,
      sequence,
      ttl_seconds: ttl,
    };
  }

  async tick(auth: HiveAuth | null, sessionID: string | null, now = Date.now()): Promise<void> {
    if (!this.config || !auth || !sessionID || this.sending) return;
    const manifest = readTerminalManifest(this.config);
    if (!manifest) return;
    const stale = manifest.state !== "ready" || now - manifest.updated_at > STALE_AFTER_MS;
    const state = stale ? "stale" : "ready";
    // One stale transition, then stop extending the TTL and let the row expire.
    if (stale && this.lastState === "stale") return;
    this.sending = true;
    try {
      const result = await request(
        auth,
        "PUT",
        `/agent-sessions/${encodeURIComponent(sessionID)}/surfaces/${this.config.surfaceID}`,
        this.body(manifest, state, this.sequence, stale ? 0 : 30),
      );
      if (!result.ok) return;
      this.lastState = state;
      // Equal sequence is an accepted refresh (the server's fence is `<=`), so
      // the heartbeat does not need to advance it; a real change does.
      this.sequence++;
    } finally {
      this.sending = false;
    }
  }

  async end(auth: HiveAuth | null, sessionID: string | null): Promise<void> {
    if (!this.config || !auth || !sessionID || this.lastState === "ended") return;
    const manifest = readTerminalManifest(this.config) ?? {
      version: 1 as const, kind: "terminal" as const, state: "ended" as const,
      rows: 0, cols: 0, updated_at: Date.now(),
    };
    this.lastState = "ended";
    // sequence + 1 satisfies the server's `sequence <= EXCLUDED.sequence` fence.
    await request(
      auth,
      "PUT",
      `/agent-sessions/${encodeURIComponent(sessionID)}/surfaces/${this.config.surfaceID}`,
      this.body(manifest, "ended", this.sequence + 1, 0),
    );
  }
}
