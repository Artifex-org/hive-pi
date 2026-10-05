import { describe, expect, it, vi } from "vitest";
import { YouShouldKnowFindingsTransport, type CapturedFinding, type FindingsRequest } from "../extensions/hive-common/you-should-know-findings.ts";
const path = "/api/v1/agent-sessions/s%2F1/you-should-know/findings";
const policy = { version: 1, recording: true, recording_revision: 2, findings: [] };
const finding = (id: string): CapturedFinding => ({ recording: true, revision: 2, serverSessionId: "s/1", finding: { id, kind: "blocker", classification: "friction", text: "Found", quote: "exact quote", source_id: "source-1", source_type: "assistant", provenance: "assistant_reported", context: "ctx", expected: "good", impact: "bad", private: "secret" } as never });
function setup(request: FindingsRequest, allowed = () => true) { const receipts = vi.fn(); const failure = vi.fn(); const onPolicy = vi.fn(); const client = new YouShouldKnowFindingsTransport({ sessionId: "s/1", request, allowed, onReceipts: receipts, onFailure: failure, onPolicy }); return { client, receipts, failure, onPolicy }; }
const ok = (body: unknown = policy) => ({ status: 200, body });
describe("YouShouldKnowFindingsTransport", () => {
 it("treats 404 and old shapes as unsupported, never POSTing", async () => { for (const response of [{ status: 404, body: {} }, ok({ version: 1, findings: [] })]) { const req = vi.fn(async () => response); const { client } = setup(req); await client.upload(); expect(client.state.unsupported).toBe(true); expect(req).toHaveBeenCalledTimes(1); } });
 it("does not GET without consent, surfaces authorization and other HTTP errors", async () => { const req = vi.fn(async () => ({ status: 403, body: {} })); const { client, failure } = setup(req, () => false); await client.discover(); expect(req).not.toHaveBeenCalled(); const allowed = setup(req); await allowed.client.discover(); expect(allowed.failure).toHaveBeenCalled(); });
 it("uploads stable batches of at most 20, stripped of private fields, only actual valid receipts", async () => {
  const calls: unknown[] = []; const request: FindingsRequest = async (method, p, body) => { calls.push([method, p, body]); return method === "GET" ? ok() : ok({ ...policy, findings: (body as {findings: {id:string}[]}).findings.map(f => ({ id: f.id, deliveries: [{ destination: "papercut", state: "queued" }] })) }); };
  const { client, receipts } = setup(request); client.capture(Array.from({ length: 21 }, (_, i) => finding(`f${i}`))); await client.upload();
  const posts = calls.filter(x => (x as unknown[])[0] === "POST") as unknown[][]; expect(posts).toHaveLength(2); expect((posts[0][2] as {findings: unknown[]}).findings).toHaveLength(20);
  expect(JSON.stringify(posts)).not.toContain("secret"); expect(receipts).toHaveBeenCalledTimes(2); expect(client.state.receipts).toHaveLength(21);
 });
 it("does not restamp old captures, upload disabled-era records, or change policy via POST", async () => {
  const bodies: unknown[] = []; const req: FindingsRequest = async (m, _p, b) => { if (m === "POST") bodies.push(b); return m === "GET" ? ok() : { status: 200, body: { ...policy, findings: [] } }; };
  const { client } = setup(req); client.capture([finding("old"), { ...finding("off"), recording: false }]); client.applyRemotePolicy({ version: 1, recording: true, recording_revision: 3 }); await client.upload(); expect(bodies).toEqual([]);
 });
 it("replays identical request after a network failure and only consumes receipt IDs", async () => {
  const bodies: unknown[] = []; let fail = true; const req: FindingsRequest = async (m, _p, b) => { if (m === "POST") { bodies.push(b); if (fail) { fail = false; throw Error("offline"); } return ok({ ...policy, findings: [{ id: "f", deliveries: [] }] }); } return ok(); };
  const { client, receipts } = setup(req); client.capture([finding("f")]); await client.upload(); expect(receipts).not.toHaveBeenCalled(); await client.upload(); expect(bodies[0]).toEqual(bodies[1]); expect(receipts).toHaveBeenCalledTimes(1); expect(client.state.receipts[0].id).toBe("f");
 });
 it("rejects unauthenticated/invalid receipts and prevents late responses after cancellation", async () => {
  const req: FindingsRequest = async m => m === "GET" ? ok() : ({ status: 200, body: { ...policy, findings: [{ id: "f", deliveries: "bad" }] } }); const { client, receipts } = setup(req); client.capture([finding("f")]); await client.upload(); expect(receipts).not.toHaveBeenCalled();
  let resolve!: (r: {status:number;body:unknown}) => void; const delayed: FindingsRequest = () => new Promise(r => { resolve = r; }); const c = setup(delayed); const pending = c.client.discover(); await Promise.resolve(); c.client.dispose(); resolve(ok()); await pending; expect(c.onPolicy).not.toHaveBeenCalled();
 });
 it("uses dedicated CAS PUT; conflict adopts authoritative state without retry", async () => {
  const calls: unknown[] = []; const req: FindingsRequest = async (m, p, b) => { calls.push([m,p,b]); return m === "GET" ? ok() : { status: 409, body: { version: 1, recording: false, recording_revision: 4 } }; };
  const { client, onPolicy, failure } = setup(req); await client.discover(); calls.length = 0; await client.setRecording(true, 2, "123e4567-e89b-42d3-a456-426614174000"); expect(calls).toEqual([["PUT", path + "/recording", { version: 1, recording: true, expected_revision: 2, control_id: "123e4567-e89b-42d3-a456-426614174000" }]]); expect(onPolicy).toHaveBeenCalledWith({ version: 1, recording: false, recording_revision: 4 }); expect(failure).toHaveBeenCalled();
 });
 it("remote policy application never sends a policy mutation", () => { const req = vi.fn(async () => ok()); const { client } = setup(req); client.applyRemotePolicy({ version: 1, recording: false, recording_revision: 9 }); expect(req).not.toHaveBeenCalled(); });
 it("a pending or failed local stop survives equal-revision enabled notifications", async () => {
  let rejectStop!: (error: Error) => void;
  const posts: unknown[] = [];
  const req: FindingsRequest = async (method, _path, body) => {
   if (method === "PUT") return new Promise((_resolve, reject) => { rejectStop = reject; });
   if (method === "POST") posts.push(body);
   return ok();
  };
  const { client, failure } = setup(req); await client.discover(); client.capture([finding("f")]);
  const stop = client.setRecording(false, 2, "123e4567-e89b-42d3-a456-426614174000");
  await vi.waitFor(() => expect(rejectStop).toBeDefined());
  client.applyRemotePolicy({ version: 1, recording: true, recording_revision: 2 });
  await client.upload(); expect(posts).toEqual([]);
  rejectStop(Error("Bearer do-not-leak-this-key")); await stop;
  await client.discover(); await client.upload(); expect(posts).toEqual([]);
  expect(JSON.stringify(failure.mock.calls)).not.toContain("do-not-leak-this-key");
 });
 it("serializes discovery behind an issued upload instead of regressing its receipts", async () => {
  let resolvePost!: (value: ReturnType<typeof ok>) => void;
  let gets = 0, completed = false;
  const delivered = { ...policy, findings: [{ id: "f", deliveries: [{ destination: "papercut", state: "delivered" }] }] };
  const req: FindingsRequest = async method => {
   if (method === "GET") { gets++; return ok(completed ? delivered : policy); }
   return new Promise(resolve => { resolvePost = value => { completed = true; resolve(value); }; });
  };
  const { client } = setup(req); await client.discover(); client.capture([finding("f")]);
  const upload = client.upload(); await vi.waitFor(() => expect(resolvePost).toBeDefined());
  const discovery = client.discover(); await Promise.resolve(); expect(gets).toBe(1);
  resolvePost(ok(delivered)); await Promise.all([upload, discovery]);
  expect(gets).toBe(2); expect(client.state.receipts[0].deliveries[0].state).toBe("delivered");
 });
 it("ignores receipts bundled with an obsolete recording policy", async () => {
  let gets = 0;
  const queued = { ...policy, findings: [{ id: "f", deliveries: [{ destination: "papercut", state: "queued" }] }] };
  const req: FindingsRequest = async method => method === "GET" ? ok(++gets === 1 ? policy : queued) : ok({ ...queued, recording_revision: 3, findings: [{ id: "f", deliveries: [{ destination: "papercut", state: "delivered" }] }] });
  const { client } = setup(req); await client.discover(); client.applyRemotePolicy({ version: 1, recording: true, recording_revision: 3 });
  client.capture([{ ...finding("f"), revision: 3 }]); await client.upload(); await client.discover();
  expect(client.state.receipts[0].deliveries[0].state).toBe("delivered");
 });
 it("releases ineligible upload queue capacity when the recording revision advances", async () => {
  const bodies: { findings: { id: string }[] }[] = [];
  const req: FindingsRequest = async (method, _path, body) => {
   if (method === "GET") return ok();
   bodies.push(body as typeof bodies[number]);
   return ok({ ...policy, recording_revision: 3, findings: [{ id: "new", deliveries: [] }] });
  };
  const { client } = setup(req); await client.discover();
  client.capture(Array.from({ length: 200 }, (_, i) => finding(`old${i}`)));
  client.applyRemotePolicy({ version: 1, recording: true, recording_revision: 3 });
  client.capture([{ ...finding("new"), revision: 3 }]); await client.upload();
  expect(bodies).toHaveLength(1); expect(bodies[0].findings.map(f => f.id)).toEqual(["new"]);
 });
 it("splits Unicode-heavy uploads below the HTTP byte limit", async () => {
  const bodies: unknown[] = [];
  const req: FindingsRequest = async (method, _path, body) => {
   if (method === "GET") return ok();
   bodies.push(body);
   return ok({ ...policy, findings: (body as { findings: { id: string }[] }).findings.map(f => ({ id: f.id, deliveries: [] })) });
  };
  const { client } = setup(req);
  client.capture(Array.from({ length: 21 }, (_, i) => { const f = finding(`f${i}`); return { ...f, finding: { ...f.finding, text: "👍".repeat(1000), quote: "👍".repeat(400), context: "👍".repeat(1000), expected: "👍".repeat(500), impact: "👍".repeat(500) } }; }));
  await client.upload(); expect(bodies.length).toBeGreaterThan(2);
  for (const body of bodies) expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(60_000);
  expect(client.state.receipts).toHaveLength(21);
 });
 it("never transfers captures from another server session", async () => {
  const req = vi.fn(async () => ok()); const { client } = setup(req);
  client.capture([{ ...finding("foreign"), serverSessionId: "other" }]); await client.upload();
  expect(req.mock.calls).toHaveLength(1); expect(client.state.receipts).toEqual([]);
 });
});
