#!/usr/bin/env python3
"""What is actually wrong when an edit anchor fails, and what the retry costs.

    python3 ~/.pi/agent/scripts/anchor-forensics.py

`measure-edit-failures.py` answers "how often, and in which category". That is
not enough to design a fix, and not enough to grade one: "ANCHOR not found"
covers a stale read, a hallucinated anchor and a one-character miss, and each
wants a different response from the tool.

METHOD. For every failed edit, find the same session's next edit call on the
same path, and compare the anchor that failed with the one that eventually
worked. The recovery is ground truth about what was wrong. Token and wall-clock
cost are accumulated over everything between the two.

THIS IS THE A/B INSTRUMENT for HIV-1562. The baseline it produced on 2026-08-09,
before `edit-common/diagnose.ts` shipped (182 sessions, 1,303 edit calls, 109
failures, 74 paired recoveries):

    31.1%  notfound: NEAR miss (>=0.6 similar to what worked)
    21.6%  ambiguous: recovery ADDED context
    12.2%  notfound: anchor was right, needed MORE context
    10.8%  notfound: partly wrong (0.2-0.6 similar)
     9.5%  notfound: anchor bore little relation to the file
     8.1%  ambiguous: recovery changed target
     5.5%  never recovered on that file
     1.4%  notfound: anchor was OVER-specified (a shorter one worked)

    retry cost   mean 1.23 edit calls, median 1, max 5
    wall clock   median 13.8s, p90 44.8s
    billed       median $0.038 per recovery, $4.50 across all 74

The money is not the case for fixing this — $4.50 over 182 sessions is noise.
The case is the 13.8s median stall, and that half of these are a model that
believes it knows the file and is a word wrong, which is a correctness smell
before it is a cost one.

Re-run after a week of the diagnosis being live. `--split-marker` partitions the
failures into those that got a diagnosis and those that did not, which is the
only comparison that attributes a change to the feature rather than to the week.
"""

import argparse
import ast
import difflib
import glob
import json
import os
import re
from collections import Counter

SESSIONS = os.path.expanduser("~/.pi/agent/sessions/**/*.jsonl")
DIAGNOSIS_MARKER = "[edit-diagnosis]"

FAILED = re.compile(
    r"(no match|not found|could not find|does not appear|multiple matches|occurrences of|"
    r"failed to apply|no changes made|did not match|must read|has not been read|"
    r"validation failed|partial apply|retryable)",
    re.I,
)


def parse_args_blob(raw):
    """Transcripts carry tool arguments as a string, sometimes JSON and
    sometimes a Python repr (pi persists whatever the provider sent)."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    for loader in (json.loads, ast.literal_eval):
        try:
            out = loader(raw)
            if isinstance(out, dict):
                return out
        except Exception:
            continue
    return {}


def old_texts(args):
    edits = args.get("edits")
    if isinstance(edits, list):
        return [e.get("oldText", "") for e in edits if isinstance(e, dict)]
    if isinstance(args.get("oldText"), str):
        return [args["oldText"]]
    return []


def result_text(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    return " ".join(p.get("text", "") for p in (content or []) if isinstance(p, dict))


def anchor_class(text):
    low = text.lower()
    if ("occurrences of" in low and "unique" in low) or "must be unique" in low:
        return "ambiguous"
    if "could not find" in low or "must match exactly" in low or "no match" in low:
        return "notfound"
    return None


def verdict_for(kind, failed_old, good_old):
    if kind == "ambiguous":
        return "ambiguous: recovery ADDED context" if len(good_old) > len(failed_old) else "ambiguous: recovery changed target"
    if failed_old and failed_old in good_old:
        return "notfound: anchor was right, needed MORE context"
    if good_old and good_old in failed_old:
        return "notfound: anchor was OVER-specified (a shorter one worked)"
    ratio = difflib.SequenceMatcher(None, failed_old, good_old).ratio()
    if ratio >= 0.6:
        return "notfound: NEAR miss (>=0.6 similar to what worked)"
    if ratio >= 0.2:
        return "notfound: partly wrong (0.2-0.6 similar)"
    return "notfound: anchor bore little relation to the file"


def load_session(path):
    """An ordered event list: ('call', id, (path, olds)) | ('result', id, (bad,
    text, ts)) | ('spend', tokens, cost)."""
    events = []
    calls = {}
    with open(path, errors="replace") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except Exception:
                continue
            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role == "assistant":
                usage = message.get("usage") or {}
                cost = usage.get("cost") or {}
                events.append(("spend", usage.get("totalTokens") or 0, cost.get("total") or 0.0))
                for part in message.get("content") or []:
                    if not isinstance(part, dict) or part.get("type") != "toolCall":
                        continue
                    if (part.get("name") or part.get("toolName")) != "edit":
                        continue
                    args = parse_args_blob(part.get("arguments"))
                    info = (args.get("path") or args.get("file_path") or "", old_texts(args))
                    calls[part.get("id")] = info
                    events.append(("call", part.get("id"), info))
            elif role == "toolResult" and message.get("toolName") == "edit":
                text = result_text(message)
                bad = bool(message.get("isError")) or bool(FAILED.search(text))
                events.append(("result", message.get("toolCallId"), (bad, text, int(message.get("timestamp") or 0))))
    return events, calls


def analyse(events, calls, arm_of):
    """Yield (verdict, arm, attempts, tokens, cost, wall_ms) per paired failure."""
    open_calls = {}
    for i, event in enumerate(events):
        if event[0] == "call":
            open_calls[event[1]] = event[2]
            continue
        if event[0] != "result":
            continue
        call_id = event[1]
        if call_id not in open_calls:
            continue
        file_path, olds = open_calls.pop(call_id)
        bad, text, ts = event[2]
        if not bad:
            continue
        kind = anchor_class(text)
        if not kind or not olds or not file_path:
            continue
        arm = arm_of(text)

        attempts = 0
        tokens = 0
        cost = 0.0
        recovery = None
        for j in range(i + 1, len(events)):
            nxt = events[j]
            if nxt[0] == "spend":
                tokens += nxt[1]
                cost += nxt[2]
                continue
            if nxt[0] != "result":
                continue
            info = calls.get(nxt[1])
            if not info or info[0] != file_path:
                continue
            attempts += 1
            nbad, _, nts = nxt[2]
            if not nbad:
                recovery = (info[1], nts)
                break
            if attempts > 12:
                break

        failed_old = max(olds, key=len)
        if recovery is None:
            yield (f"{kind}: never recovered on that file", arm, None, None, None, None)
            continue
        good_olds, good_ts = recovery
        good_old = max(good_olds, key=len) if good_olds else ""
        yield (verdict_for(kind, failed_old, good_old), arm, attempts, tokens, cost, max(0, good_ts - ts) if good_ts and ts else None)


def percentile(values, fraction):
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def report(label, rows):
    verdicts = Counter(row[0] for row in rows)
    total = sum(verdicts.values())
    if not total:
        print(f"\n{label}: no paired anchor failures")
        return
    print(f"\n{label}: {total} paired anchor failures")
    for verdict, n in verdicts.most_common():
        print(f"  {n:>4} ({100 * n / total:5.1f}%)  {verdict}")

    attempts = [row[2] for row in rows if row[2] is not None]
    tokens = [row[3] for row in rows if row[3]]
    costs = [row[4] for row in rows if row[4]]
    walls = [row[5] for row in rows if row[5]]
    if attempts:
        print(
            f"  retry cost: mean {sum(attempts) / len(attempts):.2f} edit calls, "
            f"median {percentile(attempts, 0.5)}, max {max(attempts)}"
        )
    if tokens:
        # `usage.totalTokens` is the WHOLE request, so this is context re-sent per
        # recovery, not marginal tokens generated. Six figures here is a long
        # session, not an expensive retry — read the cost line for the money and
        # the wall clock for the pain.
        print(
            f"  context re-sent:   median {percentile(tokens, 0.5):,} tok  p90 {percentile(tokens, 0.9):,}  "
            f"total {sum(tokens):,}  (full request size, NOT marginal)"
        )
    if costs:
        print(f"  billed to recover: median ${percentile(costs, 0.5):.4f}  total ${sum(costs):.2f}")
    if walls:
        print(f"  wall clock:        median {percentile(walls, 0.5) / 1000:.1f}s  p90 {percentile(walls, 0.9) / 1000:.1f}s")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--split-marker",
        action="store_true",
        help="Split by whether the failure carried an [edit-diagnosis] — the A/B for HIV-1562.",
    )
    options = parser.parse_args()

    arm_of = (lambda text: "diagnosed" if DIAGNOSIS_MARKER in text else "blind") if options.split_marker else (lambda _text: "all")

    rows = []
    sessions = 0
    for path in glob.glob(SESSIONS, recursive=True):
        sessions += 1
        events, calls = load_session(path)
        rows.extend(analyse(events, calls, arm_of))

    print(f"sessions {sessions}")
    if not options.split_marker:
        report("ALL", rows)
        return
    for arm in ("blind", "diagnosed"):
        report(arm.upper(), [row for row in rows if row[1] == arm])
    print(
        "\nRead the two arms as a comparison only once DIAGNOSED has a real n."
        "\nThe arms are not randomised — they are before and after a deploy — so a"
        "\nlarge swing in the near-miss share is the signal, not a small one in the mean."
    )


if __name__ == "__main__":
    main()
