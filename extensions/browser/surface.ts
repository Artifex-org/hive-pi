import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { CDPSession, Page } from "playwright-core";
import {
  browserSurfaceConfig,
  type BrowserSurfaceConfig,
} from "../hive-common/browserSurface.ts";

export { browserSurfaceConfig as surfaceConfig } from "../hive-common/browserSurface.ts";

const FRAME_INTERVAL_MS = 66;
const WEB_SNAPSHOT_INTERVAL_MS = 2_000;
const CONTROL_POLL_MS = 50;
const MAX_CONTROL_LINE_BYTES = 16 << 10;

interface SurfaceLease {
  id: string;
  generation: number;
  expires_at: number;
}

interface SurfaceCommand {
  id: string;
  lease_id: string;
  generation: number;
  kind: "navigate" | "mouse" | "key";
  url?: string;
  event_type?: string;
  x?: number;
  y?: number;
  button?: "none" | "left" | "middle" | "right";
  click_count?: number;
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
  metadata?: {
    deviceWidth?: number;
    deviceHeight?: number;
    timestamp?: number;
  };
}

export function nextSurfaceSequence(config: BrowserSurfaceConfig): number {
  try {
    const stat = fs.lstatSync(config.latestWebMetadata);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (16 << 10)) return 0;
    const value = JSON.parse(fs.readFileSync(config.latestWebMetadata, "utf8")) as { sequence?: unknown };
    if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || Number(value.sequence) >= Number.MAX_SAFE_INTEGER) return 0;
    return Number(value.sequence) + 1;
  } catch {
    return 0;
  }
}

function atomicWrite(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readLease(config: BrowserSurfaceConfig): SurfaceLease | null {
  try {
    const stat = fs.lstatSync(config.lease);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const value = JSON.parse(fs.readFileSync(config.lease, "utf8")) as Partial<SurfaceLease>;
    if (
      typeof value.id !== "string" ||
      value.id.length < 16 ||
      value.id.length > 128 ||
      !Number.isInteger(value.generation) ||
      typeof value.expires_at !== "number"
    ) {
      return null;
    }
    return value as SurfaceLease;
  } catch {
    return null;
  }
}

type MouseEventType = "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
type KeyEventType = "keyDown" | "keyUp" | "rawKeyDown" | "char";
const mouseEvents = new Set<MouseEventType>(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]);
const keyEvents = new Set<KeyEventType>(["keyDown", "keyUp", "rawKeyDown", "char"]);

export function validateSurfaceCommand(raw: unknown, lease: SurfaceLease | null, now = Date.now()): SurfaceCommand | null {
  if (!raw || typeof raw !== "object" || !lease || lease.expires_at <= now) return null;
  const command = raw as Partial<SurfaceCommand>;
  if (
    typeof command.id !== "string" || command.id.length < 1 || command.id.length > 128 ||
    command.lease_id !== lease.id || command.generation !== lease.generation
  ) {
    return null;
  }
  if (command.kind === "navigate") {
    if (typeof command.url !== "string" || command.url.length > 4096) return null;
    try {
      const url = new URL(command.url);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    } catch {
      return null;
    }
    return command as SurfaceCommand;
  }
  if (command.kind === "mouse") {
    if (
      typeof command.event_type !== "string" || !mouseEvents.has(command.event_type as MouseEventType) ||
      !Number.isFinite(command.x) || !Number.isFinite(command.y) ||
      Number(command.x) < 0 || Number(command.y) < 0 ||
      Number(command.x) > 16384 || Number(command.y) > 16384
    ) {
      return null;
    }
    return command as SurfaceCommand;
  }
  if (command.kind === "key") {
    if (
      typeof command.event_type !== "string" || !keyEvents.has(command.event_type as KeyEventType) ||
      (command.key?.length ?? 0) > 128 || (command.code?.length ?? 0) > 128 ||
      (command.text?.length ?? 0) > 4096
    ) {
      return null;
    }
    return command as SurfaceCommand;
  }
  return null;
}

export class BrowserSurfaceBridge {
  private frameFD = -1;
  private controlFD = -1;
  private controlBuffer = "";
  private controlTimer: NodeJS.Timeout | null = null;
  private pendingFrame: Buffer | null = null;
  private pendingFrameOffset = 0;
  private lastFrameAt = 0;
  private lastWebSnapshotAt = 0;
  private sequence: number;
  private readonly publisherID = randomUUID();
  private readonly publisherStartedAt = Date.now();
  private stopped = false;

  private constructor(
    private readonly config: BrowserSurfaceConfig,
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {
    this.sequence = nextSurfaceSequence(config);
  }

  static async start(page: Page, env: NodeJS.ProcessEnv = process.env): Promise<BrowserSurfaceBridge | null> {
    const config = browserSurfaceConfig(env);
    if (!config) return null;
    const cdp = await page.context().newCDPSession(page);
    const bridge = new BrowserSurfaceBridge(config, page, cdp);
    bridge.writeManifest("ready");
    cdp.on("Page.screencastFrame", (frame: ScreencastFrame) => void bridge.onFrame(frame));
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 72,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    bridge.controlTimer = setInterval(() => void bridge.pollControls(), CONTROL_POLL_MS);
    bridge.controlTimer.unref();
    return bridge;
  }

  private writeManifest(state: "ready" | "ended" | "error"): void {
    atomicWrite(this.config.manifest, JSON.stringify({
      version: 1,
      kind: "browser",
      state,
      launch_id: this.config.launchID,
      pid: process.pid,
      publisher_id: this.publisherID,
      publisher_started_at: this.publisherStartedAt,
      frame_fifo: "frames.fifo",
      control_fifo: "control.fifo",
      updated_at: Date.now(),
    }));
  }

  private openFrameWriter(): number {
    if (this.frameFD >= 0) return this.frameFD;
    try {
      this.frameFD = fs.openSync(this.config.frameFIFO, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch {
      this.frameFD = -1;
    }
    return this.frameFD;
  }

  private writeFrame(message: unknown): void {
    // A FIFO write larger than PIPE_BUF may be partial. Finish the current line
    // before accepting another; newer visual frames are disposable, malformed
    // JSON is not. This is a single-slot latest-value queue under backpressure.
    if (this.pendingFrame && this.pendingFrameOffset > 0) {
      this.flushFrame();
      return;
    }
    this.pendingFrame = Buffer.from(`${JSON.stringify(message)}\n`);
    this.pendingFrameOffset = 0;
    this.flushFrame();
  }

  private flushFrame(): void {
    const fd = this.openFrameWriter();
    if (fd < 0 || !this.pendingFrame) return;
    try {
      const written = fs.writeSync(
        fd,
        this.pendingFrame,
        this.pendingFrameOffset,
        this.pendingFrame.length - this.pendingFrameOffset,
      );
      this.pendingFrameOffset += written;
      if (this.pendingFrameOffset === this.pendingFrame.length) {
        this.pendingFrame = null;
        this.pendingFrameOffset = 0;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") return;
      try { fs.closeSync(fd); } catch { /* already closed */ }
      this.frameFD = -1;
      this.pendingFrame = null;
      this.pendingFrameOffset = 0;
    }
  }

  private async onFrame(frame: ScreencastFrame): Promise<void> {
    try {
      await this.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    } catch {
      return;
    }
    if (this.stopped) return;
    const now = Date.now();
    if (now - this.lastWebSnapshotAt >= WEB_SNAPSHOT_INTERVAL_MS) {
      this.lastWebSnapshotAt = now;
      const image = Buffer.from(frame.data, "base64");
      atomicWrite(this.config.latestWebImage, image);
      atomicWrite(this.config.latestWebMetadata, JSON.stringify({
        version: 1,
        sequence: this.sequence,
        publisher_id: this.publisherID,
        publisher_started_at: this.publisherStartedAt,
        content_type: "image/jpeg",
        size_bytes: image.length,
        url: this.page.url(),
        title: await this.page.title().catch(() => ""),
        width: frame.metadata?.deviceWidth ?? 0,
        height: frame.metadata?.deviceHeight ?? 0,
        updated_at: now,
      }));
    }
    if (now - this.lastFrameAt < FRAME_INTERVAL_MS) return;
    this.lastFrameAt = now;
    this.sequence++;
    this.writeFrame({
      type: "frame",
      sequence: this.sequence,
      publisher_id: this.publisherID,
      publisher_started_at: this.publisherStartedAt,
      content_type: "image/jpeg",
      data: frame.data,
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      width: frame.metadata?.deviceWidth ?? 0,
      height: frame.metadata?.deviceHeight ?? 0,
      timestamp: frame.metadata?.timestamp ?? now / 1000,
    });
  }

  private openControlReader(): number {
    if (this.controlFD >= 0) return this.controlFD;
    try {
      // O_RDWR keeps the FIFO present while no desktop writer is connected;
      // O_RDONLY would return EOF immediately and make every writer race the
      // 50ms reopen window. This fd belongs to the extension and closes in stop.
      this.controlFD = fs.openSync(this.config.controlFIFO, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    } catch {
      this.controlFD = -1;
    }
    return this.controlFD;
  }

  private pollControls(): void {
    if (this.stopped) return;
    const fd = this.openControlReader();
    if (fd < 0) return;
    const chunk = Buffer.allocUnsafe(4096);
    try {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) {
        fs.closeSync(fd);
        this.controlFD = -1;
        return;
      }
      this.controlBuffer += chunk.subarray(0, n).toString("utf8");
      if (Buffer.byteLength(this.controlBuffer) > MAX_CONTROL_LINE_BYTES) this.controlBuffer = "";
      let newline = this.controlBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.controlBuffer.slice(0, newline);
        this.controlBuffer = this.controlBuffer.slice(newline + 1);
        if (Buffer.byteLength(line) <= MAX_CONTROL_LINE_BYTES) void this.applyCommand(line);
        newline = this.controlBuffer.indexOf("\n");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        this.controlFD = -1;
      }
    }
  }

  private async applyCommand(line: string): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const command = validateSurfaceCommand(raw, readLease(this.config));
    if (!command) return;
    try {
      if (command.kind === "navigate") {
        await this.page.goto(command.url!);
      } else if (command.kind === "mouse") {
        await this.cdp.send("Input.dispatchMouseEvent", {
          type: command.event_type as MouseEventType,
          x: command.x!,
          y: command.y!,
          button: command.button ?? "none",
          clickCount: command.click_count ?? 0,
          modifiers: command.modifiers ?? 0,
        });
      } else {
        await this.cdp.send("Input.dispatchKeyEvent", {
          type: command.event_type as KeyEventType,
          key: command.key ?? "",
          code: command.code ?? "",
          text: command.text ?? "",
          modifiers: command.modifiers ?? 0,
        });
      }
      this.writeFrame({ type: "control_result", id: command.id, ok: true });
    } catch {
      this.writeFrame({ type: "control_result", id: command.id, ok: false });
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.controlTimer) clearInterval(this.controlTimer);
    try { await this.cdp.send("Page.stopScreencast"); } catch { /* browser already closed */ }
    try { await this.cdp.detach(); } catch { /* browser already closed */ }
    for (const fd of [this.frameFD, this.controlFD]) {
      if (fd >= 0) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    this.writeManifest("ended");
  }
}
