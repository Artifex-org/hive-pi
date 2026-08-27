#!/usr/bin/env python3
"""
Edit-failure rate by actor, from pi session transcripts (HIV-1562).

Answers "how often does an edit fail, and why" — the measurement that decides
whether a hash-anchored edit format (oh-my-pi's hashline, KB
`infrastructure/harness/oh-my-pi-survey.md`) is worth adopting, and for WHICH
actor. Re-run it before revisiting that decision; do not re-argue from the
published benchmark, which is author-produced on synthetic single-token bugs.

    python3 ~/.pi/agent/scripts/measure-edit-failures.py

Two things about the data, both measured rather than assumed, and both capable
of producing a confident wrong answer:

1. **hive-telemetry cannot answer this.** It is metrics-only by design — no code
   path reads `tool_execution_*.args/.result`. And subagent workers run
   `--no-session`, so they write no transcript of their own. The only record is
   the PARENT session's JSONL, because the parent folds the worker's JSON stream
   into messages it persists.

2. **Tool results are not content parts.** They are their own entries:
   `message.role === "toolResult"`, carrying `toolName` and `isError`. The first
   version of this script looked for `toolResult` inside `message.content[]`,
   found none, and reported a 0.0% failure rate over 1,140 edits — a check that
   could not fail, in the flattering direction.
"""

import glob
import json
import os
import re
from collections import Counter, defaultdict

SESSIONS = os.path.expanduser("~/.pi/agent/sessions/**/*.jsonl")
EDIT_TOOLS = {"edit", "write", "str_replace", "apply_patch", "multi_edit"}

# isError is authoritative; the text patterns catch tools that report a failed
# edit with isError unset (partial applies, "RETRYABLE" prefixes).
FAILED = re.compile(
    r"(no match|not found|could not find|does not appear|multiple matches|occurrences of|"
    r"failed to apply|no changes made|did not match|must read|has not been read|"
    r"validation failed|partial apply|retryable)",
    re.I,
)


def classify(text: str) -> str:
    """Why the edit failed. Order matters — several messages match more than one
    pattern, and the anchor classes must not be shadowed by generic ones."""
    low = text.lower()
    if "validation failed for tool" in low:
        return "schema/validation (malformed call)"
    if "blocked" in low or "permission denied" in low:
        return "guard/permission"
    if "enoent" in low or "no such file" in low:
        return "missing file"
    if "has not been read" in low or "must read" in low:
        return "unread file (workflow)"
    if ("occurrences of" in low and "unique" in low) or "multiple matches" in low or "must be unique" in low:
        return "ANCHOR ambiguous (matched N>1)"
    if "appears" in low and "times" in low:
        return "ANCHOR ambiguous (matched N>1)"
    if (
        "could not find" in low
        or "was not found" in low
        or "does not appear" in low
        or "must match exactly" in low
        or "no match" in low
        or "did not match" in low
    ):
        return "ANCHOR not found (exact-string miss)"
    return "other"


def is_failure(message: dict, text: str) -> bool:
    return bool(message.get("isError") or FAILED.search(text))


def result_text(message: dict) -> str:
    return " ".join(p.get("text", "") for p in (message.get("content") or []) if isinstance(p, dict))


def scan(messages) -> tuple[int, Counter]:
    """(edit_calls, failure_categories) over a flat list of pi messages."""
    edits = 0
    categories: Counter = Counter()
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            for part in message.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "toolCall":
                    if (part.get("name") or part.get("toolName") or "").lower() in EDIT_TOOLS:
                        edits += 1
        elif role == "toolResult" and (message.get("toolName") or "").lower() in EDIT_TOOLS:
            text = result_text(message)
            if is_failure(message, text):
                categories[classify(text)] += 1
    return edits, categories


def find_subagent_results(node, sink):
    if isinstance(node, dict):
        results = node.get("results")
        if isinstance(results, list) and results and isinstance(results[0], dict) and "agent" in results[0]:
            sink.extend(results)
            return
        for value in node.values():
            find_subagent_results(value, sink)
    elif isinstance(node, list):
        for value in node:
            find_subagent_results(value, sink)


def main() -> None:
    workers = defaultdict(lambda: {"edits": 0, "cats": Counter(), "runs": 0})
    main_edits = 0
    main_cats: Counter = Counter()
    sessions = 0
    runs = 0

    for path in glob.glob(SESSIONS, recursive=True):
        sessions += 1
        messages = []
        with open(path, errors="replace") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                message = entry.get("message")
                if isinstance(message, dict):
                    messages.append(message)
                if '"agentSource"' not in line:
                    continue
                found = []
                find_subagent_results(entry, found)
                for result in found:
                    runs += 1
                    nested = result.get("messages")
                    if not isinstance(nested, list) or not nested:
                        continue
                    edits, cats = scan(nested)
                    key = (result.get("agent") or "(unknown)", result.get("model") or "(unspecified)")
                    workers[key]["edits"] += edits
                    workers[key]["cats"] += cats
                    workers[key]["runs"] += 1
        edits, cats = scan(messages)
        main_edits += edits
        main_cats += cats

    print(f"sessions {sessions} · subagent runs {runs}\n")

    worker_edits = sum(v["edits"] for v in workers.values())
    worker_fails = sum(sum(v["cats"].values()) for v in workers.values())
    print("WORKERS (subagent roles)")
    if worker_edits:
        for (role, model), value in sorted(workers.items(), key=lambda kv: -kv[1]["edits"]):
            if not value["edits"]:
                continue
            fails = sum(value["cats"].values())
            print(f"  {100*fails/value['edits']:5.1f}%  {fails:>4}/{value['edits']:<5} {value['runs']:>3} runs  {role} / {model}")
        print(f"  {'-'*60}\n  {100*worker_fails/worker_edits:5.1f}%  {worker_fails:>4}/{worker_edits:<5}        ALL WORKERS")
    else:
        print("  no edit-shaped calls recorded")

    print("\nMAIN SESSION (orchestrator)")
    main_fails = sum(main_cats.values())
    if main_edits:
        print(f"  {100*main_fails/main_edits:5.1f}%  {main_fails:>4}/{main_edits:<5}")
    else:
        print("  no edit-shaped calls recorded")

    combined = main_cats + sum((v["cats"] for v in workers.values()), Counter())
    total_fails = sum(combined.values())
    total_edits = main_edits + worker_edits
    if not total_fails:
        return
    print("\nFAILURE CAUSES (all actors)")
    anchor = 0
    for cat, n in combined.most_common():
        flag = "  <-- hash-anchoring addresses this" if cat.startswith("ANCHOR") else ""
        print(f"  {n:>4} ({100*n/total_fails:5.1f}%)  {cat}{flag}")
        if cat.startswith("ANCHOR"):
            anchor += n
    print(
        f"\n  ANCHOR-CLASS: {anchor}/{total_fails} = {100*anchor/total_fails:.1f}% of failures"
        f" = {100*anchor/total_edits:.2f}% of all {total_edits} edits"
    )


if __name__ == "__main__":
    main()
