import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { CDPSession, Page } from "playwright-core";
import {
  browserSurfaceConfig,
  type BrowserSurfaceConfig,
} from "../hive-common/browserSurface.ts";

export { browserSurfaceConfig as surfaceConfig } from "../hive-common/browserSurface.ts";

// The wire contract is hive's docs/agent-live-browser.md §1–4 (the surface
// dir, the bridge NDJSON, the lease and the control commands). The desktop app
// (desktop/src-tauri/src/surface.rs) and hive-agent's relay are the peers.

const FRAME_INTERVAL_MS = 66;
const WEB_SNAPSHOT_INTERVAL_MS = 2_000;
const CONTROL_POLL_MS = 50;
const MAX_CONTROL_LINE_BYTES = 16 << 10;
/** A sink still holding bytes the pipe refused is retried this soon (one timer, not a loop). */
const FLUSH_RETRY_MS = 15;
/** Control results waiting behind a partly written frame, per sink. */
const MAX_QUEUED_RESULTS = 64;
/** Commands waiting their turn; beyond this a command is answered `failed`. */
const MAX_QUEUED_COMMANDS = 256;
/** One command's CDP work (input, opening a tab, switching the view). */
const COMMAND_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const HISTORY_TIMEOUT_MS = 10_000;
const PASSWORD_CHECK_TIMEOUT_MS = 1_000;
const SCREENCAST_SWITCH_TIMEOUT_MS = 2_000;
const SCREENCAST_RETRY_MS = 1_000;
/** Frames inspected for a focused password field (the main frame first). */
const MAX_FRAMES_CHECKED = 32;
const MAX_KEY_TEXT = 2_000;
const MAX_WHEEL_DELTA = 10_000;

const SCREENCAST_OPTIONS = {
  format: "jpeg",
  quality: 72,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
} as const;

/** What every agent page tool says while an operator holds the agent's page. */
export const AGENT_PAUSED_MESSAGE =
  "The operator has taken control of this browser from Hive's live view. Wait for them to release it, or ask in chat.";

export type SurfaceView = "agent" | "operator";
/**
 * Chromium edits text for a key event only when it carries a virtual key
 * code: without one, Backspace, Delete, the arrows and Enter arrive as keys
 * that do nothing. Derived from the DOM `code`, which the web viewer sends.
 */
const NAMED_KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16,
  ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, Escape: 27, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
  ArrowDown: 40, Insert: 45, Delete: 46, MetaLeft: 91, MetaRight: 92,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
  BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
};

export function keyCodes(code: string | undefined): { windowsVirtualKeyCode?: number; nativeVirtualKeyCode?: number } {
  if (!code) return {};
  let vk = NAMED_KEY_CODES[code];
  const letter = /^Key([A-Z])$/.exec(code);
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (letter) vk = letter[1]!.charCodeAt(0);
  else if (digit) vk = (code.startsWith("Numpad") ? 96 : 48) + Number(digit[1]);
  else if (fn) vk = 111 + Number(fn[1]);
  return vk === undefined ? {} : { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
}

/** Any character that is not a C0 control or DEL: text that could be a secret. */
const PRINTABLE = /[^\u0000-\u001f\u007f]/;

export type SurfaceCommandError =
  | "password_field" | "invalid" | "failed" | "no_operator_tab" | "no_lease" | "take_over_required";

export interface SurfaceLease {
  id: string;
  generation: number;
  expires_at: number;
  /** "relay" or "desktop"; absent means the desktop app (it predates the field). */
  holder?: string;
  /** True only for a take-over of the agent's own page. */
  exclusive: boolean;
}

export interface SurfaceCommand {
  id: string;
  lease_id: string;
  generation: number;
  kind: "navigate" | "mouse" | "key" | "history" | "insert_text" | "tab";
  url?: string;
  event_type?: string;
  x?: number;
  y?: number;
  button?: string;
  click_count?: number;
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
  delta_x?: number;
  delta_y?: number;
  action?: string;
  view?: SurfaceView;
}

export type SurfaceCommandCheck =
  | { ok: true; command: SurfaceCommand }
  | { ok: false; id: string | null; error: "invalid" | "no_lease" };

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
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > (4 << 10)) return null;
    const value = JSON.parse(fs.readFileSync(config.lease, "utf8")) as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      value.id.length < 16 ||
      value.id.length > 128 ||
      !Number.isInteger(value.generation) ||
      typeof value.expires_at !== "number"
    ) {
      return null;
    }
    return {
      id: value.id,
      generation: Number(value.generation),
      expires_at: value.expires_at,
      ...(typeof value.holder === "string" ? { holder: value.holder.slice(0, 32) } : {}),
      exclusive: value.exclusive === true,
    };
  } catch {
    return null;
  }
}

function leaseActive(lease: SurfaceLease | null, now: number): lease is SurfaceLease {
  return lease !== null && lease.expires_at > now;
}

/**
 * The agent's own page tools refuse iff an unexpired lease is exclusive (a
 * take-over) and the operator is looking at the agent's page — with an
 * operator tab in view, the two drive different pages.
 */
export function leasePausesAgent(lease: SurfaceLease | null, view: SurfaceView, now = Date.now()): boolean {
  return leaseActive(lease, now) && lease.exclusive && view === "agent";
}

type MouseEventType = "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
type KeyEventType = "keyDown" | "keyUp" | "rawKeyDown" | "char";
type MouseButton = "none" | "left" | "middle" | "right" | "back" | "forward";
const mouseEvents = new Set<string>(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]);
const keyEvents = new Set<string>(["keyDown", "keyUp", "rawKeyDown", "char"]);
const mouseButtons = new Set<string>(["none", "left", "middle", "right", "back", "forward"]);
const historyActions = new Set<string>(["back", "forward", "reload"]);

// The desktop app serialises every unset optional field as `null`.
function absent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function optionalString(value: unknown, max: number): boolean {
  return absent(value) || (typeof value === "string" && value.length <= max);
}

function optionalInteger(value: unknown, min: number, max: number): boolean {
  return absent(value) || (Number.isInteger(value) && Number(value) >= min && Number(value) <= max);
}

function optionalNumber(value: unknown, min: number, max: number): boolean {
  return absent(value) || (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}

function coordinate(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 16384;
}

function safeHTTPURL(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function present<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

function commandID(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" && id.length >= 1 && id.length <= 128 ? id : null;
}

/**
 * Validate one parsed control line against the lease. A failure says whether
 * the command can be answered (it carries a usable `id`) and why: `no_lease`
 * when no unexpired lease exists, `invalid` for everything else (a lease or
 * generation that is not the current one, a field out of bounds, an unknown
 * kind). A success is a fresh object with only the known fields, nulls dropped.
 */
export function checkSurfaceCommand(raw: unknown, lease: SurfaceLease | null, now = Date.now()): SurfaceCommandCheck {
  const id = commandID(raw);
  if (id === null) return { ok: false, id: null, error: "invalid" };
  if (!leaseActive(lease, now)) return { ok: false, id, error: "no_lease" };
  const c = raw as Record<string, unknown>;
  const invalid: SurfaceCommandCheck = { ok: false, id, error: "invalid" };
  if (c.lease_id !== lease.id || c.generation !== lease.generation) return invalid;
  const base = { id, lease_id: lease.id, generation: lease.generation };
  switch (c.kind) {
    case "navigate":
      if (!safeHTTPURL(c.url)) return invalid;
      return { ok: true, command: { ...base, kind: "navigate", url: c.url } };
    case "mouse":
      if (
        typeof c.event_type !== "string" || !mouseEvents.has(c.event_type) ||
        !coordinate(c.x) || !coordinate(c.y) ||
        !(absent(c.button) || (typeof c.button === "string" && mouseButtons.has(c.button))) ||
        !optionalInteger(c.click_count, 0, 16) ||
        !optionalInteger(c.modifiers, 0, 15) ||
        !optionalNumber(c.delta_x, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA) ||
        !optionalNumber(c.delta_y, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA)
      ) {
        return invalid;
      }
      return {
        ok: true,
        command: {
          ...base,
          kind: "mouse",
          event_type: c.event_type,
          x: c.x as number,
          y: c.y as number,
          button: present(c.button as string | null | undefined),
          click_count: present(c.click_count as number | null | undefined),
          modifiers: present(c.modifiers as number | null | undefined),
          delta_x: present(c.delta_x as number | null | undefined),
          delta_y: present(c.delta_y as number | null | undefined),
        },
      };
    case "key":
      if (
        typeof c.event_type !== "string" || !keyEvents.has(c.event_type) ||
        !optionalString(c.key, 128) || !optionalString(c.code, 128) ||
        !optionalString(c.text, MAX_KEY_TEXT) ||
        !optionalInteger(c.modifiers, 0, 15)
      ) {
        return invalid;
      }
      return {
        ok: true,
        command: {
          ...base,
          kind: "key",
          event_type: c.event_type,
          key: present(c.key as string | null | undefined),
          code: present(c.code as string | null | undefined),
          text: present(c.text as string | null | undefined),
          modifiers: present(c.modifiers as number | null | undefined),
        },
      };
    case "history":
      if (typeof c.action !== "string" || !historyActions.has(c.action)) return invalid;
      return { ok: true, command: { ...base, kind: "history", action: c.action } };
    case "insert_text":
      if (typeof c.text !== "string" || c.text.length < 1 || c.text.length > MAX_KEY_TEXT) return invalid;
      return { ok: true, command: { ...base, kind: "insert_text", text: c.text } };
    case "tab":
      if (c.action === "open") {
        if (!safeHTTPURL(c.url)) return invalid;
        return { ok: true, command: { ...base, kind: "tab", action: "open", url: c.url } };
      }
      if (c.action === "close") return { ok: true, command: { ...base, kind: "tab", action: "close" } };
      if (c.action === "view" && (c.view === "agent" || c.view === "operator")) {
        return { ok: true, command: { ...base, kind: "tab", action: "view", view: c.view } };
      }
      return invalid;
    default:
      return invalid;
  }
}

/** The validated command, or null — `checkSurfaceCommand` without the reason. */
export function validateSurfaceCommand(raw: unknown, lease: SurfaceLease | null, now = Date.now()): SurfaceCommand | null {
  const checked = checkSurfaceCommand(raw, lease, now);
  return checked.ok ? checked.command : null;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** A command refused for a reason the controller is told (`control_result.error`). */
class SurfaceRefusal extends Error {
  readonly code: SurfaceCommandError;

  constructor(code: SurfaceCommandError) {
    super(code);
    this.code = code;
  }
}

/**
 * One NDJSON reader's FIFO. A FIFO write larger than PIPE_BUF may be partial,
 * so a started line is always finished before another begins (malformed JSON
 * is never acceptable). Behind it, frames are a single-slot latest-value
 * queue — a newer frame replaces one not yet started — and control results
 * wait in a short bounded queue so a frame cannot erase an answer. A FIFO
 * with no reader (or no FIFO at all) drops everything: an answer queued for
 * a reader that has gone would reach the wrong one.
 */
export class FrameSink {
  private fd = -1;
  private current: Buffer | null = null;
  private currentIsFrame = false;
  private offset = 0;
  private frame: Buffer | null = null;
  private results: Buffer[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** True while bytes are waiting for the reader to drain the pipe. */
  get pending(): boolean {
    return this.current !== null || this.frame !== null || this.results.length > 0;
  }

  push(line: Buffer, kind: "frame" | "result"): void {
    if (kind === "frame") {
      this.frame = line;
      // A frame the pipe has not taken a byte of is replaced too.
      if (this.current && this.currentIsFrame && this.offset === 0) this.current = null;
    } else {
      if (this.results.length >= MAX_QUEUED_RESULTS) this.results.shift();
      this.results.push(line);
    }
    this.flush();
  }

  flush(): void {
    if (!this.pending) return;
    const fd = this.open();
    if (fd < 0) {
      this.clear();
      return;
    }
    for (;;) {
      if (!this.current) {
        const result = this.results.shift();
        if (result) {
          this.current = result;
          this.currentIsFrame = false;
        } else if (this.frame) {
          this.current = this.frame;
          this.currentIsFrame = true;
          this.frame = null;
        } else {
          return;
        }
        this.offset = 0;
      }
      try {
        this.offset += fs.writeSync(fd, this.current, this.offset, this.current.length - this.offset);
        if (this.offset === this.current.length) this.current = null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") return;
        // EPIPE (the reader went), EBADF, …: reopen on the next line.
        this.close();
        this.clear();
        return;
      }
    }
  }

  close(): void {
    if (this.fd >= 0) try { fs.closeSync(this.fd); } catch { /* already closed */ }
    this.fd = -1;
  }

  private clear(): void {
    this.current = null;
    this.frame = null;
    this.results = [];
    this.offset = 0;
  }

  private open(): number {
    if (this.fd >= 0) return this.fd;
    let fd = -1;
    try {
      // ENOENT (an older node creates no relay FIFO) and ENXIO (no reader yet)
      // land here; so does a symlink (O_NOFOLLOW).
      fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(fd).isFIFO()) {
        fs.closeSync(fd);
        return -1;
      }
    } catch {
      if (fd >= 0) try { fs.closeSync(fd); } catch { /* already closed */ }
      return -1;
    }
    this.fd = fd;
    return fd;
  }
}

/** A command whose answer waits for a navigation; null when it is already done. */
type Dispatched = { navigation: Promise<unknown> } | null;

/**
 * Hand a navigation back unawaited. It is marked handled now: if the command
 * timed out meanwhile, nobody else will ever attach to it.
 */
function navigating(navigation: Promise<unknown>): Dispatched {
  navigation.catch(() => {});
  return { navigation };
}

/** One page the bridge can show and drive, with its own CDP session. */
interface SurfaceTarget {
  page: Page;
  cdp: CDPSession;
}

interface LastFrame {
  target: SurfaceTarget;
  data: string;
  url: string;
  title: string;
  width: number;
  height: number;
  timestamp: number;
}

// Evaluated in each frame: is the deepest focused element (through open
// shadow roots) a password input? Plain JS — it runs in the page.
const FOCUSED_PASSWORD = `(() => {
  let element = document.activeElement;
  while (element && element.shadowRoot && element.shadowRoot.activeElement) element = element.shadowRoot.activeElement;
  return { focused: document.hasFocus(), password: !!element && element.tagName === "INPUT" && String(element.type).toLowerCase() === "password" };
})()`;

export class BrowserSurfaceBridge {
  private controlFD = -1;
  private controlBuffer = "";
  private controlTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private lastWebSnapshotAt = 0;
  private sequence: number;
  private readonly publisherID = randomUUID();
  private readonly publisherStartedAt = Date.now();
  private stopped = false;
  // Plain fields, not parameter properties: the Claude adapter loads this file
  // under Node's type stripping, which accepts erasable syntax only.
  private readonly config: BrowserSurfaceConfig;
  private readonly agent: SurfaceTarget;
  private readonly log: (line: string) => void;
  private readonly sinks: FrameSink[];
  private lastFailure = "";
  private operator: SurfaceTarget | null = null;
  /** The page frames show and input reaches. */
  private view: SurfaceView = "agent";
  /** The view asked for; `applyView` brings `view` and the screencast to it. */
  private wantedView: SurfaceView = "agent";
  /** The target whose screencast is running; a frame from any other is dropped. */
  private casting: SurfaceTarget | null = null;
  private viewChain: Promise<void> = Promise.resolve();
  private castRetryAt = 0;
  private commandChain: Promise<void> = Promise.resolve();
  private queuedCommands = 0;
  /** lease.json as of the last control tick (frame status only; commands re-read it). */
  private lease: SurfaceLease | null = null;
  private lastFrame: LastFrame | null = null;
  /** The newest screencast frame not yet sent (see `scheduleEmit`). */
  private pendingFrame: { target: SurfaceTarget; frame: ScreencastFrame; at: number } | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private emitToken = 0;
  private lastStatus = "";

  private constructor(config: BrowserSurfaceConfig, agent: SurfaceTarget, log: (line: string) => void) {
    this.config = config;
    this.agent = agent;
    this.log = log;
    this.sinks = [new FrameSink(config.frameFIFO), new FrameSink(config.relayFrameFIFO)];
    this.sequence = nextSurfaceSequence(config);
  }

  /**
   * `log` reports a frame the live view had to drop (its write failed: the
   * scratch dir removed, a full disk) — once per distinct cause.
   */
  static async start(
    page: Page,
    env: NodeJS.ProcessEnv = process.env,
    log: (line: string) => void = (line) => console.warn(line),
  ): Promise<BrowserSurfaceBridge | null> {
    const config = browserSurfaceConfig(env);
    if (!config) return null;
    const cdp = await page.context().newCDPSession(page);
    const bridge = new BrowserSurfaceBridge(config, { page, cdp }, log);
    bridge.writeManifest("ready");
    bridge.listen(bridge.agent);
    bridge.casting = bridge.agent;
    await cdp.send("Page.startScreencast", SCREENCAST_OPTIONS);
    bridge.lease = readLease(config);
    bridge.controlTimer = setInterval(() => bridge.tick(), CONTROL_POLL_MS);
    bridge.controlTimer.unref();
    return bridge;
  }

  /**
   * True while an operator's exclusive lease holds the agent's page (see
   * `leasePausesAgent`). Read fresh: a tool call must not race a tick.
   */
  agentPaused(now = Date.now()): boolean {
    return !this.stopped && leasePausesAgent(readLease(this.config), this.view, now);
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

  /** Say what the live view had to give up — once per distinct cause, not per frame or tick. */
  private report(what: string, error: unknown): void {
    const reason = `${what} — ${error instanceof Error ? error.message : String(error)}`;
    if (reason !== this.lastFailure) this.log(`browser live view: ${reason}`);
    this.lastFailure = reason;
  }

  private listen(target: SurfaceTarget): void {
    target.cdp.on("Page.screencastFrame", (frame: ScreencastFrame) => void this.onFrame(target, frame));
  }

  /** Every NDJSON line goes to every sink; each keeps its own backlog. */
  private writeLine(message: unknown, kind: "frame" | "result"): void {
    const line = Buffer.from(`${JSON.stringify(message)}\n`);
    for (const sink of this.sinks) sink.push(line, kind);
    this.scheduleFlush();
  }

  private flushSinks(): void {
    for (const sink of this.sinks) sink.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.stopped || !this.sinks.some((sink) => sink.pending)) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSinks();
      this.scheduleFlush();
    }, FLUSH_RETRY_MS);
    this.flushTimer.unref();
  }

  private writeResult(id: string, error?: SurfaceCommandError): void {
    this.writeLine({ type: "control_result", id, ok: !error, ...(error ? { error } : {}) }, "result");
  }

  private status(now = Date.now()): { view: SurfaceView; operator_tab: boolean; agent_paused: boolean } {
    return {
      view: this.view,
      operator_tab: this.operator !== null,
      agent_paused: leasePausesAgent(this.lease, this.view, now),
    };
  }

  // Runs detached (`void` from the CDP event): a throw here would be an
  // unhandled rejection that takes the host process down. The frame is
  // dropped instead, and the cause said once.
  private async onFrame(target: SurfaceTarget, frame: ScreencastFrame): Promise<void> {
    try {
      await this.publishFrame(target, frame);
    } catch (error) {
      this.report("dropped a frame", error);
    }
  }

  private async publishFrame(target: SurfaceTarget, frame: ScreencastFrame): Promise<void> {
    try {
      await target.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    } catch {
      return;
    }
    if (this.stopped || target !== this.casting) return;
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
        url: target.page.url(),
        title: await target.page.title().catch(() => ""),
        width: frame.metadata?.deviceWidth ?? 0,
        height: frame.metadata?.deviceHeight ?? 0,
        updated_at: now,
      }));
    }
    this.pendingFrame = { target, frame, at: now };
    this.scheduleEmit();
  }

  /**
   * At most one frame per FRAME_INTERVAL_MS, and the newest one wins — a
   * trailing edge, not a leading one: a static page sends no frame after its
   * last change (nor after a view switch, past the first), so the frame that
   * arrives inside the interval is the one the viewer must end on.
   */
  private scheduleEmit(): void {
    if (this.emitTimer || this.stopped) return;
    const wait = Math.max(0, FRAME_INTERVAL_MS - (Date.now() - this.lastFrameAt));
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      void this.emitPending().catch((error: unknown) => this.report("dropped a frame", error));
    }, wait);
    this.emitTimer.unref();
  }

  private async emitPending(): Promise<void> {
    const pending = this.pendingFrame;
    this.pendingFrame = null;
    if (!pending || this.stopped || pending.target !== this.casting) return;
    this.lastFrameAt = Date.now();
    const token = ++this.emitToken;
    const { target, frame } = pending;
    const title = await target.page.title().catch(() => "");
    // The view may have moved on while the title was read, or a newer frame
    // started (a slow title must not let an older picture land last).
    if (this.stopped || target !== this.casting || token !== this.emitToken) return;
    this.lastFrame = {
      target,
      data: frame.data,
      url: target.page.url(),
      title,
      width: frame.metadata?.deviceWidth ?? 0,
      height: frame.metadata?.deviceHeight ?? 0,
      timestamp: frame.metadata?.timestamp ?? pending.at / 1000,
    };
    this.emitFrame();
  }

  private emitFrame(): void {
    const last = this.lastFrame;
    if (!last) return;
    const status = this.status();
    this.lastStatus = JSON.stringify(status);
    this.sequence++;
    this.writeLine({
      type: "frame",
      sequence: this.sequence,
      publisher_id: this.publisherID,
      publisher_started_at: this.publisherStartedAt,
      content_type: "image/jpeg",
      data: last.data,
      url: last.url,
      title: last.title,
      width: last.width,
      height: last.height,
      timestamp: last.timestamp,
      ...status,
    }, "frame");
  }

  /**
   * A static page sends no screencast frames, so a status change (a lease
   * taken or released, a tab closed) would never reach the viewer. Re-send
   * the last picture with the new status — only while it still shows the
   * page in view; after a switch the new screencast's first frame does it.
   */
  private republishOnStatusChange(): void {
    if (!this.lastFrame || this.lastFrame.target !== this.casting) return;
    if (JSON.stringify(this.status()) !== this.lastStatus) this.emitFrame();
  }

  private tick(): void {
    if (this.stopped) return;
    try {
      this.lease = readLease(this.config);
      const now = Date.now();
      if (!leaseActive(this.lease, now)) void this.switchView("agent");
      this.retryScreencast(now);
      this.republishOnStatusChange();
      this.pollControls();
      this.flushSinks();
      this.scheduleFlush();
    } catch (error) {
      // A timer callback: a throw would take the host down.
      this.report("control tick failed", error);
    }
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
        if (Buffer.byteLength(line) <= MAX_CONTROL_LINE_BYTES) this.enqueue(line);
        newline = this.controlBuffer.indexOf("\n");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        this.controlFD = -1;
      }
    }
  }

  /**
   * Commands run one at a time, in arrival order: a key's password check is
   * asynchronous, and a keyUp must not overtake its keyDown. Navigation runs
   * outside the queue (see `runCommand`), so a slow page does not hold input.
   */
  private enqueue(line: string): void {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    if (this.queuedCommands >= MAX_QUEUED_COMMANDS) {
      const id = commandID(raw);
      if (id) this.writeResult(id, "failed");
      return;
    }
    this.queuedCommands++;
    this.commandChain = this.commandChain
      .then(() => this.runCommand(raw))
      .catch(() => {})
      .finally(() => { this.queuedCommands--; });
  }

  private async runCommand(raw: unknown): Promise<void> {
    if (this.stopped) return;
    const lease = readLease(this.config);
    const checked = checkSurfaceCommand(raw, lease);
    if (!checked.ok) {
      if (checked.id) this.writeResult(checked.id, checked.error);
      return;
    }
    const command = checked.command;
    // A remote operator's shared lease ("own tab") may open and switch tabs,
    // but drives the agent's own page only by taking it over, which pauses
    // the agent. Enforced here, where the view is known, not in a viewer. The
    // desktop app's lease (no holder) keeps driving the agent page as before.
    if (command.kind !== "tab" && lease?.holder === "relay" && lease.exclusive !== true && this.inputTarget() === this.agent) {
      this.writeResult(command.id, "take_over_required");
      return;
    }
    let dispatched: Dispatched;
    try {
      dispatched = await withTimeout(this.dispatch(command), COMMAND_TIMEOUT_MS, command.kind);
    } catch (error) {
      this.writeResult(command.id, error instanceof SurfaceRefusal ? error.code : "failed");
      return;
    }
    if (!dispatched) {
      this.writeResult(command.id);
      return;
    }
    // Bounded by the navigation's own timeout.
    void dispatched.navigation.then(
      () => { if (!this.stopped) this.writeResult(command.id); },
      () => { if (!this.stopped) this.writeResult(command.id, "failed"); },
    );
  }

  /** The page input reaches: the operator tab while it is in view. */
  private inputTarget(): SurfaceTarget {
    return this.view === "operator" && this.operator ? this.operator : this.agent;
  }

  /**
   * Does the work. A navigation is handed back unawaited, wrapped (an async
   * function would otherwise wait for the promise it returns), to be
   * answered when it settles.
   */
  private async dispatch(command: SurfaceCommand): Promise<Dispatched> {
    const target = this.inputTarget();
    switch (command.kind) {
      case "navigate":
        return navigating(target.page.goto(command.url!, { timeout: NAVIGATION_TIMEOUT_MS }));
      case "history":
        if (command.action === "back") return navigating(target.page.goBack({ timeout: HISTORY_TIMEOUT_MS }));
        if (command.action === "forward") return navigating(target.page.goForward({ timeout: HISTORY_TIMEOUT_MS }));
        return navigating(target.page.reload({ timeout: HISTORY_TIMEOUT_MS }));
      case "mouse": {
        const type = command.event_type as MouseEventType;
        await target.cdp.send("Input.dispatchMouseEvent", {
          type,
          x: command.x!,
          y: command.y!,
          button: (command.button ?? "none") as MouseButton,
          clickCount: command.click_count ?? 0,
          modifiers: command.modifiers ?? 0,
          ...(type === "mouseWheel" ? { deltaX: command.delta_x ?? 0, deltaY: command.delta_y ?? 0 } : {}),
        });
        return null;
      }
      case "key":
        // Control characters (Enter's "\r", Tab, Backspace) submit or edit; they
        // are not secret text, and refusing them would block submitting a
        // login form with Enter.
        if (command.text && PRINTABLE.test(command.text)) await this.refuseIntoPassword(target);
        await target.cdp.send("Input.dispatchKeyEvent", {
          type: command.event_type as KeyEventType,
          key: command.key ?? "",
          code: command.code ?? "",
          text: command.text ?? "",
          modifiers: command.modifiers ?? 0,
          ...keyCodes(command.code),
        });
        return null;
      case "insert_text":
        await this.refuseIntoPassword(target);
        await target.cdp.send("Input.insertText", { text: command.text! });
        return null;
      case "tab":
        return this.applyTab(command);
    }
  }

  /**
   * Text never reaches a focused password field from the live view. Every
   * frame is asked (a login form is often an iframe); a child frame counts
   * only while it holds focus, as its activeElement outlives the focus. A
   * page that cannot answer (mid-navigation) refuses rather than guesses.
   */
  private async refuseIntoPassword(target: SurfaceTarget): Promise<void> {
    // Past the cap a password field could sit in a frame nobody asked: refuse.
    if (target.page.frames().length > MAX_FRAMES_CHECKED) throw new SurfaceRefusal("password_field");
    const frames = target.page.frames();
    const main = target.page.mainFrame();
    const answers = await withTimeout(
      Promise.all(frames.map((frame) =>
        frame.evaluate(FOCUSED_PASSWORD).then(
          (value) => ({ frame, value: value as { focused: boolean; password: boolean } }),
          (error: unknown) => (frame === main ? Promise.reject(error) : null),
        ))),
      PASSWORD_CHECK_TIMEOUT_MS,
      "password check",
    );
    if (answers.some((answer) => answer && answer.value.password && (answer.frame === main || answer.value.focused))) {
      throw new SurfaceRefusal("password_field");
    }
  }

  private async applyTab(command: SurfaceCommand): Promise<Dispatched> {
    if (command.action === "open") {
      const target = this.operator ?? await this.openOperatorTab();
      await this.switchView("operator");
      return navigating(target.page.goto(command.url!, { timeout: NAVIGATION_TIMEOUT_MS }));
    }
    if (command.action === "close") {
      const target = this.operator;
      if (!target) throw new SurfaceRefusal("no_operator_tab");
      this.operator = null;
      await this.switchView("agent");
      await target.page.close().catch(() => {});
      await target.cdp.detach().catch(() => {});
      return null;
    }
    if (command.view === "operator" && !this.operator) throw new SurfaceRefusal("no_operator_tab");
    await this.switchView(command.view!);
    return null;
  }

  /** One operator tab, in the agent's own context: its cookies, its loopback. */
  private async openOperatorTab(): Promise<SurfaceTarget> {
    const page = await this.agent.page.context().newPage();
    let cdp: CDPSession;
    try {
      cdp = await page.context().newCDPSession(page);
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
    const target = { page, cdp };
    if (this.stopped) {
      await page.close().catch(() => {});
      throw new Error("browser live view stopped");
    }
    this.listen(target);
    // Closed by the page itself (window.close, a crash): view the agent again.
    page.on("close", () => {
      if (this.operator !== target) return;
      this.operator = null;
      void cdp.detach().catch(() => {});
      void this.switchView("agent");
    });
    this.operator = target;
    return target;
  }

  /**
   * Ask for a view; switches are serialised and coalesced (the control tick
   * asks for `agent` every 50 ms while no lease exists). Never rejects.
   */
  private switchView(view: SurfaceView): Promise<void> {
    if (this.wantedView === view) return this.viewChain;
    this.wantedView = view;
    this.viewChain = this.viewChain.then(() => this.applyView()).catch((error: unknown) => this.report("switching the view failed", error));
    return this.viewChain;
  }

  /**
   * Move the screencast to the wanted page: one CDP session per page, so the
   * old page's screencast stops and the new one's starts (its first frame
   * carries the new `view`). If the operator tab cannot cast, the agent's
   * page is shown again.
   */
  private async applyView(): Promise<void> {
    if (this.stopped) return;
    const want = this.wantedView === "operator" && this.operator ? this.operator : this.agent;
    this.view = want === this.agent ? "agent" : "operator";
    if (this.casting === want) return;
    const old = this.casting;
    this.casting = want;
    if (old) await withTimeout(old.cdp.send("Page.stopScreencast"), SCREENCAST_SWITCH_TIMEOUT_MS, "stopping the screencast").catch(() => {});
    try {
      await withTimeout(want.cdp.send("Page.startScreencast", SCREENCAST_OPTIONS), SCREENCAST_SWITCH_TIMEOUT_MS, "starting the screencast");
      return;
    } catch (error) {
      if (want === this.agent) {
        // Nothing is casting: the control tick retries (`retryScreencast`).
        this.casting = null;
        throw error;
      }
    }
    this.wantedView = "agent";
    this.view = "agent";
    this.casting = this.agent;
    try {
      await withTimeout(this.agent.cdp.send("Page.startScreencast", SCREENCAST_OPTIONS), SCREENCAST_SWITCH_TIMEOUT_MS, "starting the screencast");
    } catch (error) {
      this.casting = null;
      throw error;
    }
  }

  /** A screencast that failed to start is tried again, at most once a second. */
  private retryScreencast(now: number): void {
    if (this.casting || now < this.castRetryAt) return;
    this.castRetryAt = now + SCREENCAST_RETRY_MS;
    this.viewChain = this.viewChain.then(() => this.applyView()).catch((error: unknown) => this.report("switching the view failed", error));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.controlTimer) clearInterval(this.controlTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    const casting = this.casting;
    this.casting = null;
    if (casting) try { await casting.cdp.send("Page.stopScreencast"); } catch { /* browser already closed */ }
    for (const target of [this.agent, this.operator]) {
      if (target) try { await target.cdp.detach(); } catch { /* browser already closed */ }
    }
    for (const sink of this.sinks) sink.close();
    if (this.controlFD >= 0) try { fs.closeSync(this.controlFD); } catch { /* already closed */ }
    this.writeManifest("ended");
  }
}
