import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentitySync, IDENTITY_SYNC_ENTRY, type IdentitySyncState } from "../extensions/hive-remote/identitySync.ts";
import type { RemoteSessionIdentity } from "../extensions/hive-remote/client.ts";
import type { SessionIdentityUpdate } from "../extensions/hive-remote/sessionIdentityBus.ts";
import type { RequestResult } from "../extensions/hive-common/http.ts";

const canonical = (revision = 0, description = ""): RemoteSessionIdentity => ({ title: "Task", description, description_provisional: false, identity_revision: revision });
const success = (body: RemoteSessionIdentity): RequestResult<RemoteSessionIdentity> => ({ ok: true, status: 200, authFailed: false, permanent: false, retryAfterMs: null, body });
const failure = (status: number, body?: RemoteSessionIdentity): RequestResult<RemoteSessionIdentity> => ({ ok: false, status, authFailed: false, permanent: status < 500, retryAfterMs: null, body, error: "unavailable" });
const update = (description: string, source: SessionIdentityUpdate["source"] = "description"): SessionIdentityUpdate => ({ title: "Task", description, source, provisional: false, revision: 1, origin: "session-identity", ...(source === "pivot" ? { reason: "New objective" } : {}) });
const settle = () => vi.advanceTimersByTimeAsync(0);
function fixture() {
  const persisted: IdentitySyncState[] = [];
  const apply = vi.fn();
  const notice = vi.fn();
  const sync = new IdentitySync({ persist: state => persisted.push(state), apply, notice });
  const read = vi.fn(async () => success(canonical()));
  const put = vi.fn(async (body: { revision: number; description: string }) => success(canonical(body.revision, body.description)));
  return { sync, persisted, apply, notice, read, put };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("persisted identity outbox", () => {
  it("never contacts an old server without a positive capability", async () => {
    const f = fixture();
    f.sync.update(update("Local paragraph"));
    f.sync.attach(false, f);
    await settle();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
    expect(f.persisted.at(-1)?.queue[0].update.description).toBe("Local paragraph");
  });
  it("serializes overlapping edits without letting the old response erase the newest", async () => {
    const f = fixture();
    let release!: (value: RequestResult<RemoteSessionIdentity>) => void;
    f.put.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.sync.attach(true, f); await settle();
    f.sync.update(update("First edit")); await settle();
    f.sync.update(update("Second edit")); await settle();
    expect(f.put).toHaveBeenCalledTimes(1);
    release(success(canonical(1, "First edit"))); await settle();
    expect(f.put).toHaveBeenCalledTimes(2);
    expect(f.put.mock.calls.map(([body]) => body.revision)).toEqual([1, 2]);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.apply).toHaveBeenLastCalledWith(canonical(2, "Second edit"));
    expect(f.persisted.at(-1)?.queue).toEqual([]);
  });
  it("preserves a pin while still sending the required pivot title", async () => {
    const f = fixture();
    f.read.mockResolvedValue(success({ ...canonical(3, "Old context"), title: "Operator name", title_pinned: true }));
    f.put.mockResolvedValue(success({ ...canonical(4, "New context"), title: "Operator name", title_pinned: true }));
    f.sync.attach(true, f); await settle();
    f.sync.update(update("New context", "pivot")); await settle();
    expect(f.put).toHaveBeenCalledWith(expect.objectContaining({ title: "Task", source: "pivot", reason: "New objective", revision: 4 }));
    expect(f.apply.mock.calls.at(-1)?.[0].title).toBe("Operator name");
  });
  it("retries exactly the same wire revision and fingerprint after transient failure", async () => {
    const f = fixture();
    f.put.mockResolvedValueOnce(failure(503));
    f.sync.update(update("Initial context", "initial"));
    f.sync.attach(true, f); await settle();
    const first = f.put.mock.calls[0][0];
    expect(f.persisted.find(state => state.queue[0]?.wireRevision === 1)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.put.mock.calls[1][0]).toEqual(first);
    expect(f.persisted.at(-1)?.queue).toEqual([]);
  });
  it("recognizes a lost successful response on resume and drains the newer durable edit", async () => {
    const f = fixture();
    const head = update("Accepted context", "initial");
    f.sync.restore([{ customType: IDENTITY_SYNC_ENTRY, data: { remoteRevision: 0, queue: [{ update: head, wireRevision: 1 }, { update: update("Later edit") }] } }]);
    f.read.mockResolvedValue(success(canonical(1, "Accepted context")));
    f.sync.attach(true, f); await settle();
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.put).toHaveBeenCalledWith(expect.objectContaining({ description: "Later edit", revision: 2 }));
    expect(f.apply).toHaveBeenLastCalledWith(canonical(2, "Later edit"));
  });
  it("quarantines newer unpublished edits on conflict and requires a fresh explicit context", async () => {
    const f = fixture();
    let release!: (value: RequestResult<RemoteSessionIdentity>) => void;
    f.put.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.sync.attach(true, f); await settle();
    f.sync.update(update("Old edit")); await settle();
    f.sync.update(update("Newer but possibly stale-goal edit"));
    release(failure(409, canonical(8, "Someone else's objective"))); await settle();
    expect(f.apply).toHaveBeenLastCalledWith(canonical(8, "Someone else's objective"));
    expect(f.persisted.at(-1)).toMatchObject({ conflicted: true, remoteRevision: 8 });
    expect(f.persisted.at(-1)?.queue.at(-1)?.update.description).toBe("Newer but possibly stale-goal edit");
    expect(f.put).toHaveBeenCalledTimes(1);
    f.sync.detach(); f.sync.attach(true, f); await settle();
    expect(f.put).toHaveBeenCalledTimes(1);
    f.read.mockResolvedValue(success(canonical(8, "Someone else's objective")));
    f.sync.update(update("Reviewed and intentionally refined context")); await settle();
    expect(f.put).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 9, description: "Reviewed and intentionally refined context" }));
  });
  it("bounds automatic retries, retains pending work, and restarts retries on reconnect", async () => {
    const f = fixture();
    f.put.mockResolvedValue(failure(503));
    f.sync.update(update("Durable pending context")); f.sync.attach(true, f); await settle();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(f.put).toHaveBeenCalledTimes(6);
    expect(f.notice).toHaveBeenLastCalledWith(expect.stringContaining("sync paused"));
    expect(f.persisted.at(-1)?.queue[0].update.description).toBe("Durable pending context");
    f.sync.detach();
    f.put.mockImplementation(async body => success(canonical(body.revision, body.description)));
    f.sync.attach(true, f); await settle();
    expect(f.put).toHaveBeenCalledTimes(7);
    expect(f.persisted.at(-1)?.queue).toEqual([]);
  });
  it("pins a manual name arriving during an identity PUT without applying its stale title", async () => {
    const f = fixture();
    let release!: (value: RequestResult<RemoteSessionIdentity>) => void;
    f.put.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const rename = vi.fn(async (_title: string): Promise<RequestResult<void>> => ({ ok: true, status: 204, authFailed: false, permanent: false, retryAfterMs: null }));
    f.sync.attach(true, { ...f, rename }); await settle();
    f.sync.update(update("Pending paragraph")); await settle();
    f.sync.rename("Operator title");
    f.read.mockResolvedValue(success({ ...canonical(1, "Pending paragraph"), title: "Operator title", title_pinned: true }));
    release(success(canonical(1, "Pending paragraph"))); await settle();
    expect(rename).toHaveBeenCalledExactlyOnceWith("Operator title");
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: "Operator title", title_pinned: true }));
    expect(f.persisted.at(-1)?.manualTitle).toBeUndefined();
  });
  it("does not overwrite a newer manual name during the post-PATCH GET", async () => {
    const f = fixture();
    f.read.mockResolvedValue(success(canonical(3, "Context")));
    const rename = vi.fn(async (_title: string): Promise<RequestResult<void>> => ({ ok: true, status: 204, authFailed: false, permanent: false, retryAfterMs: null }));
    f.sync.attach(true, { ...f, rename }); await settle(); f.apply.mockClear();
    let release!: (value: RequestResult<RemoteSessionIdentity>) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.sync.rename("First manual name"); await settle();
    f.sync.rename("Newest manual name");
    f.read.mockResolvedValue(success({ ...canonical(3, "Context"), title: "Newest manual name", title_pinned: true }));
    release(success({ ...canonical(3, "Context"), title: "First manual name", title_pinned: true })); await settle();
    expect(rename.mock.calls.map(([title]) => title)).toEqual(["First manual name", "Newest manual name"]);
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: "Newest manual name" }));
  });
  it("restores and retries an unsent manual pin before accepting the old canonical name", async () => {
    const f = fixture();
    f.sync.restore([{ customType: IDENTITY_SYNC_ENTRY, data: { remoteRevision: 6, queue: [], manualTitle: "Persisted manual title" } }]);
    f.read.mockResolvedValueOnce(success({ ...canonical(6, "Context"), title: "Old canonical title" }));
    f.read.mockResolvedValue(success({ ...canonical(6, "Context"), title: "Persisted manual title", title_pinned: true }));
    const rename = vi.fn(async (_title: string): Promise<RequestResult<void>> => ({ ok: true, status: 204, authFailed: false, permanent: false, retryAfterMs: null }));
    f.sync.attach(true, { ...f, rename }); await settle();
    expect(rename).toHaveBeenCalledExactlyOnceWith("Persisted manual title");
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: "Persisted manual title" }));
  });
  it("fences late GET and PATCH responses after replacing the session", async () => {
    const f = fixture();
    let releaseRead!: (value: RequestResult<RemoteSessionIdentity>) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve; }));
    f.sync.attach(true, f); await settle(); f.sync.restore([]);
    releaseRead(success(canonical(4, "Old session"))); await settle();
    expect(f.apply).not.toHaveBeenCalled();
    let releasePin!: (value: RequestResult<void>) => void;
    const rename = vi.fn(() => new Promise<RequestResult<void>>(resolve => { releasePin = resolve; }));
    f.sync.attach(true, { ...f, rename }); await settle();
    f.sync.rename("Old session name"); await settle(); f.sync.restore([]);
    releasePin({ ok: true, status: 204, authFailed: false, permanent: false, retryAfterMs: null }); await settle();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("ignores late replies after replacing the active session", async () => {
    const f = fixture();
    let release!: (value: RequestResult<RemoteSessionIdentity>) => void;
    f.put.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.sync.attach(true, f); await settle(); f.sync.update(update("Old session")); await settle();
    f.sync.restore([]);
    release(success(canonical(1, "Old session"))); await settle();
    expect(f.apply).not.toHaveBeenCalled();
  });
});
