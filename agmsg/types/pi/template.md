---
name: __SKILL_NAME__
description: Cross-agent messaging via SQLite. Send messages between pi, Claude Code, Codex, Gemini CLI and other agents. No daemon, no network, no dependencies beyond bash and sqlite3.
---

Agent messaging for **pi**.

> **On pi, prefer the tools and the command over these scripts.** The hive-pi
> `agmsg` extension registers `agmsg_send`, `agmsg_inbox`, `agmsg_team` and
> `agmsg_history`, plus a `/agmsg` command for the human. They wrap exactly the
> scripts below, so the two are interchangeable — but the tools already know
> this session's role, and incoming messages are pushed into the session rather
> than polled for. Fall back to the scripts only when the extension is not
> loaded (`pi --no-extensions`, or a pi without hive-pi installed).

**IMPORTANT: Always use the provided scripts. NEVER read or edit the config
files, the DB, or team data directly. There is NO register.sh — use join.sh to
join a team.** All scripts are Bash; run them through `bash`.

## Identity

If the extension is loaded, `/agmsg` prints the current role and delivery mode
and there is nothing to resolve. Otherwise:

`~/.agents/skills/__SKILL_NAME__/scripts/whoami.sh "$(pwd)" pi`

**A) Single identity:** `agent=<name> teams=<t1,...> type=pi project=<path>`
→ remember AGENT and TEAMS, continue below.

**B) Multiple identities:** `multiple=true agents=<n1,n2,...> ...`
→ ask the user which name this session should use, then claim it:
`/agmsg actas <name>` (or `~/.agents/skills/__SKILL_NAME__/scripts/actas-claim.sh "$(pwd)" pi <name> "$PI_SESSION_ID.$$"`).

**C) Not in a team:** `not_joined=true available_teams=<t1,t2,...>`
→ show the user the available teams, then:

  1. Ask for a team name (joins an existing team or creates a new one).
  2. For an existing team, run `~/.agents/skills/__SKILL_NAME__/scripts/team.sh <team>`
     first and propose 2–3 unused names that fit the roster's existing naming
     convention. Never propose a bare tool label like `pi`.
  3. Join: `/agmsg join <team> <name>` (or `join.sh <team> <name> pi "$(pwd)"`).
  4. **Pick a delivery mode — do not skip this.** Ask exactly:

     ```
     Choose delivery mode for incoming messages:

       1) monitor — Real-time push. The extension holds an inbox watcher open and
                    injects messages into this session, even while it sits idle.
                    Recommended.

       2) turn    — Check the inbox after each completed turn.

       3) off     — No automatic delivery. Manual /agmsg only.

     [1]:
     ```

     Empty input means `1`. Then run `/agmsg mode <monitor|turn|off>` (or
     `delivery.sh set <mode> pi "$(pwd)"`). Monitor takes effect immediately in
     this session; no restart is needed.

**D) Suggestions for reuse:** `suggest=true agents=<n1,...> ...`
→ offer those names, ask which to reuse (or a new one) and which team, then join
as in C.

## Execute

| Intent | Tool (preferred) | Script |
| --- | --- | --- |
| Check inbox | `agmsg_inbox` | `inbox.sh <team> <agent>` |
| Send | `agmsg_send` | `send.sh <team> <from> <to> "<message>"` |
| Roster | `agmsg_team` | `team.sh <team>` |
| History | `agmsg_history` | `history.sh <team> <agent>` |
| Status / mode / join / actas | `/agmsg` | `delivery.sh`, `join.sh`, `actas-claim.sh` |

Answer an incoming `[agmsg]` message with `agmsg_send` addressed to its sender.
Text written outside a tool call reaches the user of THIS session, not the agent
who wrote to you.

Scripts live in `~/.agents/skills/__SKILL_NAME__/scripts/`. To redirect storage,
use `AGMSG_STORAGE_PATH`; never construct DB paths by hand.
