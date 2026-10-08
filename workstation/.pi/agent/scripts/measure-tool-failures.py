#!/usr/bin/env python3
"""Measure bash/codemode result errors, separately from recorded nested errors.

Local transcripts are not a census of remote or factory agents. A nonzero shell
exit is not necessarily a harness defect. Reports contain aggregates only, not
commands, result bodies or credentials. Use explicit --since/--until bounds to
repeat a measurement; --until is exclusive. Delegated worker internals are not
unpacked. Unlike outer-result flags, nestedCalls also captures caught errors.

    uv run --no-project python measure-tool-failures.py --since 2026-10-01T00:00:00Z
"""

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path


def instant(value):
    if not isinstance(value, str):
        raise ValueError("timestamp must be a string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def text_of(message):
    return "\n".join(
        part.get("text", "") for part in message.get("content", [])
        if isinstance(part, dict) and part.get("type") == "text"
    )


def diagnostic(text):
    if "Script error:" in text:
        text = text.split("Script error:", 1)[1].split("Tool calls made before the failure", 1)[0]
    return text.strip()


def measure(root, since, until, excluded):
    outer = Counter()
    discovery_sessions = set()
    discovery_by_day = Counter()
    sessions = set()
    seen = set()
    nested = Counter()
    timeouts = Counter()
    stats = Counter()
    for path in sorted(root.rglob("*.jsonl")):
        if path.stem in excluded:
            continue
        model = "unknown"
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except (ValueError, UnicodeError):
                    stats["parse_errors"] += 1
                    continue
                if not isinstance(entry, dict):
                    stats["parse_errors"] += 1
                    continue
                if entry.get("type") == "model_change":
                    model = f'{entry.get("provider", "unknown")}/{entry.get("modelId", "unknown")}'
                message = entry.get("message", {})
                if not isinstance(message, dict) or message.get("role") != "toolResult":
                    continue
                name = message.get("toolName")
                if name not in ("bash", "codemode"):
                    continue
                try:
                    timestamp = instant(entry["timestamp"])
                except (KeyError, ValueError, TypeError):
                    stats["invalid_timestamps"] += 1
                    continue
                if not since <= timestamp < until:
                    continue
                call_id = message.get("toolCallId")
                if call_id:
                    if call_id in seen:
                        stats["duplicate_results"] += 1
                        continue
                    seen.add(call_id)
                sessions.add(path.stem)
                text = text_of(message)
                failed = bool(message.get("isError") or (name == "codemode" and text.startswith("Script failed")))
                day = timestamp.date().isoformat()
                outer[(model, day, name, "results")] += 1
                outer[(model, day, name, "errors")] += failed
                if failed and re.search(r"Command timed out after \d+ seconds", diagnostic(text)):
                    timeouts[f"outer_{name}"] += 1
                if failed and re.search(r"(?:^|\n)TypeError: tools\.tool_search does not exist\.", diagnostic(text)):
                    stats["model_only_discovery_errors"] += 1
                    discovery_sessions.add(path.stem)
                    discovery_by_day[day] += 1
                if name != "codemode":
                    continue
                record = message.get("nestedCalls")
                if not isinstance(record, dict):
                    stats["scripts_without_nested_record"] += 1
                    continue
                stats["scripts_with_nested_record"] += 1
                stats["incomplete_nested_records"] += record.get("complete") is False
                errors = 0
                for call in record.get("calls", []):
                    tool, status = call.get("name", "unknown"), call.get("status", "unknown")
                    nested[(tool, status)] += 1
                    errors += status == "error"
                    if status == "error" and tool == "bash" and re.search(r"Command timed out after \d+ seconds", call.get("error", "")):
                        timeouts["nested_bash"] += 1
                if not failed and errors:
                    stats["completed_scripts_with_nested_errors"] += 1
                    stats["nested_errors_in_completed_scripts"] += errors
    rows = []
    for model, day, name in sorted({key[:3] for key in outer}):
        rows.append({"model": model, "day": day, "tool": name,
                     "results": outer[(model, day, name, "results")],
                     "errors": outer[(model, day, name, "errors")]})
    return {
        "window": {"since_inclusive": since.isoformat(), "until_exclusive": until.isoformat()},
        "sessions": len(sessions),
        "outer_by_model_day": rows,
        "nested_by_tool_status": [{"tool": tool, "status": status, "calls": count}
                                  for (tool, status), count in sorted(nested.items())],
        "discovery_error_sessions": len(discovery_sessions),
        "discovery_errors_by_day": dict(sorted(discovery_by_day.items())),
        "timeout_signatures": dict(timeouts),
        "coverage": dict(stats),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sessions-root", type=Path, default=Path.home() / ".pi/agent/sessions")
    now = datetime.now(timezone.utc)
    parser.add_argument("--since", type=instant, default=now - timedelta(days=7))
    parser.add_argument("--until", type=instant, default=now)
    parser.add_argument("--exclude-session", action="append", default=[], help="exact filename stem; repeatable")
    args = parser.parse_args()
    if not args.sessions_root.is_dir():
        parser.error("sessions root must be an existing directory")
    if args.since >= args.until:
        parser.error("--since must precede --until")
    print(json.dumps(measure(args.sessions_root, args.since, args.until, set(args.exclude_session)), indent=2))


if __name__ == "__main__":
    main()
