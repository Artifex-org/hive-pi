# Persistent addressable subagents + A2A messaging — design study (HIV-1235)

Status: **studied, NO-GO for now** — revisit when a concrete multi-day task actually wants it.
Research base: KB `infrastructure/harness/harness-frontier-2026-08.md` (prime-agent deep-dive; Claude Code Agent Teams).

## The pattern under evaluation

Two frontier data points converge on "spawn once, follow up later":

- **prime-agent**: `rlm()` returns a handle at admission and never the child's answer; children are full agents with their own session trees, persistent and addressable ACROSS sessions; results arrive only via `agent_message` replies (`auto | steer | follow_up`) or files. Scope-restricted to the "nuclear family" (parent/sibling/child) with delivered/queued receipts. Backed by a daemon.
- **Claude Code Agent Teams**: a lead agent plus 2–16 teammates, each with its own context window and git worktree, messaging each other peer-to-peer (TeammateTool) rather than only reporting to the parent.

What we already have covers most of the surface: `orchestrate` with `caps.durable=true` starts a background run and returns its id immediately; its RPC workers stream `report` events upward, accept `worker_send` supervision (`steer | follow_up | stop`), push one bounded completion, and retain full output behind `orchestrate_result`. Multiple follow-up waves share one eight-worker live ceiling. The genuine gaps are (a) workers die with the session (`session_shutdown → workers.stopAll()`), (b) no addressing from a *later* session, and (c) no peer-to-peer channel.

## The four design questions, answered

**1. Does it compose with the one-writer-per-worktree lock and worker inertness?**
Partially. A cross-session persistent WRITER is a standing hazard: the lock file (`harness/writer.ts`) is scoped to a worktree and released on worker exit — a worker that outlives its session holds the slot invisibly against every future session in that checkout (this exact class is why `session_shutdown` calls `stopAll()` today, and why [[post-merge-worktree-reuse]] exists as a memory). Persistent *readers* (a long-lived reviewer/researcher) compose fine — they never contend for the slot. Any build would have to be **read-only-persistent, writer-ephemeral**.

**2. Session-entry vs daemon-based mailbox?**
We have no daemon and should not grow one for this — that is the fork-shaped complexity HIV-1070 declined. The natural transports, in order: (a) **files in the worktree** (already doctrine: "the file is the ground truth, the message is a pointer"); (b) the **Hive agents workspace** (`hive-remote` already gives sessions an addressable identity, transcripts, and `steer_agent` — a persistent subagent is very nearly "a second pi session registered with hive-remote", making Hive the mailbox with zero new infrastructure); (c) session entries (wrong tool — they are per-session by construction).

**3. Does read-parallel/write-serial survive peer messaging?**
It survives only if peers cannot write. Cognition's objection — two agents making conflicting implicit decisions from divergent partial context — applies to *decisions that reach the tree*. Peer-messaging read-only agents is coordination, not conflict. The moment two writer-capable peers coordinate directly, the supervisor no longer sees the decisions being made, and `worker_send`'s "one level, one supervisor" comment (N(N−1)/2 races) applies. Any build keeps hub-and-spoke for writers.

**4. Does the ≥4-independent-subtasks threshold say this pays at single-user scale?**
Mostly no. The empirical fan-out boundary is about parallel *throughput*; persistence is about *continuity* — a reviewer that keeps its context across days. This is **not** an argument against a 4–8-worker in-session wave: those workers are bounded by the task and stop with their run/session. At single-user scale the cross-session continuity cases are rare and mostly served today by: durable workers within a session, `/handoff` seeds across sessions, files (`PLAN.md`/`PROGRESS.md`), and the KB. The one real candidate is a standing reviewer with accumulated context over a multi-day epic — which is equally well served by re-spawning a reader against the PR diff + its own previous report (files as memory), at the cost of some cold-start tokens and none of the lifecycle machinery.

## Recommendation

**NO-GO on new machinery now.** The 20% gap does not justify: cross-session process supervision (orphans, stale locks, crash cleanup), a mailbox contract, and a second identity/addressing scheme — against a workload that has not yet produced a task the existing durable-worker + handoff + files combination failed.

Cheap partial worth doing if the need materializes: let `worker_send` address workers by reading the registry from the **Hive agents workspace** instead of only the in-process `WorkerRegistry` — i.e. treat any live pi session (including a manually started long-lived reader in another tmux pane) as addressable. That reuses hive-remote's existing identity, transcript, and steer plumbing wholesale.

Re-open when: a multi-day epic demonstrably loses context/money to reader re-spawning, or the Hive-native knowledge system lands (it changes what "a subagent remembers" means — accumulated knowledge may belong there, not in a long-lived process).
