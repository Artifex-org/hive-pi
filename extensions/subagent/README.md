# Local pi subagent extension

Pinned fork of the pi 0.83.0 in-tree `examples/extensions/subagent/` example, imported on 2026-08-05 for HIV-1032. Do not track upstream blindly: review and re-verify changes when the pi pin moves.

The executable extension and baseline roles live in this package. The extension rejects parallel writer-capable roles that resolve to the same cwd/worktree. Use `/delegate <task>` for the shortest explicit invocation path.

### Which model a subagent runs

Highest precedence first:

1. **The role's own `model:` frontmatter** — a per-role pin is deliberate tuning and is never overridden. Only `retriever` sets one today.
2. **`PI_SUBAGENT_MODEL`** — set by whoever launched the session. Hive stamps it on a workstation agent launch from the models configured on its Factory settings page, so an orchestrated run uses the fleet's models rather than this machine's.
3. **`subagentDefaultModel` in `~/.pi/agent/settings.json`** — currently `openrouter/deepseek/deepseek-v4-flash`. This is what a hand-started interactive session uses.

The env var exists so a launcher never has to write `settings.json`: on the workstation that file is a stow symlink into a git checkout, and pi rewrites it on `/model`, so a third writer would fight both.

## Local role inventory

- Domain: `borealis-trader`, `babysit-build`, `incident-responder`, `k8s-deployment-manager`, `omarchy-config-manager`, `aurora-developer`
- Read-only: `research`, `code-reviewer`
- Focused cheap writers: `lint-fixer`, `test-fixer`, `doc-writer`

## Upstream example documentation

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Live health widget**: Refreshes every second with elapsed time and time since the child's last JSON event, so a long-running tool is visibly alive rather than appearing frozen
- **Usage tracking**: Shows per-agent turns, input/output/cache tokens, context usage, model, and cost when available
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Live widget while a subagent runs**:
- Refreshes once per second, including while the child has not emitted a new JSON event
- Shows the elapsed time plus `no event <duration>`; this is observability, not a failure verdict — a tool can legitimately be quiet while it waits on I/O
- Shows live, per-agent token/context totals as soon as the child emits an assistant completion
- Is removed when the parent subagent tool settles, preventing stale “working” panels

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
# Omit model to inherit subagentDefaultModel from the workstation config.
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | composer-2-5 | read, grep, find, ls, bash |
| `planner` | Implementation plans | composer-2-5 | read, grep, find, ls |
| `reviewer` | Code review | composer-2-5 | read, grep, find, ls, bash |
| `worker` | General-purpose | composer-2-5 | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent


## Typed results (`schema`, HIV-1563)

Pass a JSON Schema as `schema` (single mode) or per item in `tasks[]`, and the
worker's answer is validated before you see it: the parent extracts the last
fenced JSON block, checks it, retries once with the validation error, and
returns the validated object both in the tool result and in `details`.

Workers run `--no-extensions`, so there is no structured-output *tool* to force
inside the child — the contract rides the appended system prompt, and the fenced
block is the channel. That is why the retry is a whole fresh worker: it has no
memory of the first attempt, so the retry task carries the failure with it.

**Two schema rules, enforced rather than documented:**

- **Never set `additionalProperties: false`.** The call is REJECTED before a
  worker spawns, with an error naming the rule. A closed schema turns a worker's
  extra field into a hard failure, and the retry then invents duplicate field
  names instead of dropping it — measured as 25 rejections in one Workflow
  window.
- **`required` only the fields you actually branch on.** Anything documented
  "empty if none" must be optional, or it fails the opposite way.

A retry is spent only on a run that SUCCEEDED with the wrong shape, and never on
a writer-capable role: re-running one that already wrote its changes would fold
to `NO_CHANGE_ERROR` on an unchanged tree.

Chain mode and `orchestrate` stages are not wired yet.
