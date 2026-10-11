---
name: analytics-visualisation
description: Analyse datasets and present trends or comparisons with validated inline charts. Use for data analysis, metrics, visualisation, and chart requests; prefer precise tables when charting adds little. Owning-app business dashboards remain the app-analytics-dashboard workflow.
---

# Analytics and visualisation

Use charts when they clarify a trend or comparison; prefer a compact table when exact values matter. `render_chart` produces inline line/bar cards; stable `chart_id`s replace the same card in the Charts pane. Keep within 8 series × 100 points, finite numbers, clear labels/units, and disclose source, time range, transformations and missing-data handling. Do not interpolate, silently drop gaps or imply causality.

For existing data, call `render_chart` with `type`, `title`, optional `subtitle`, `unit`, optional stable `chart_id`, and `series: [{name, points:[{x,y}]}]`. In Claude, `mcp__hive-pi__render_chart` supports static series only; the pi `render_chart` tool also supports the live JSONL feed described below.

## Background JSONL feed

`render_chart` never runs shell commands. To visualize an ongoing local/test job, have a separately guarded background-job tool (such as `background_bash` when available) write full replacement snapshots to a **pre-created regular JSONL file**, then call `render_chart` with its relative `source_file` and explicit `chart_id`. Paths resolve relative to the tool execution directory. Only one producer may write a given `chart_id`; do not truncate or replace the file while it is being watched. Append newline-terminated JSON objects. Each regular row is a complete `{series:[...]}` snapshot; optional `title`, `subtitle`, and `unit` update metadata. Metadata is allowlisted: row values cannot change chart `type` or `chart_id`.

If the runtime has no guarded background-job tool, use static snapshots instead; do not detach an unmanaged shell process. Create a private feed first, then run the producer as a separately guarded background job:

```sh
umask 077
mktemp "${TMPDIR:-/tmp}/hive-chart.XXXXXX.jsonl"
```

Use the returned path in place of `/tmp/latency.jsonl` below. Start the producer through the guarded background manager (without shelling out from `render_chart`):

```sh
for i in 1 2 3; do
  printf '{"title":"Latency test","unit":"ms","series":[{"name":"latency","points":[{"x":"sample-%s","y":%s}]}]}\n' "$i" "$((10 + i))" >> /tmp/latency.jsonl
  sleep 1
done
printf '{"done":true}\n' >> /tmp/latency.jsonl
```

Then call `render_chart` with `type: "line"`, `title: "Latency test"`, `chart_id: "latency-test"`, `source_file: "/tmp/latency.jsonl"`, and `timeout_seconds: 15`. The shell snippet above is a `background_bash` command; do not add `&` because the background manager owns the producer lifecycle. A Python producer can similarly use `open(path, "a", encoding="utf-8")`, write one `json.dumps(snapshot) + "\n"` at a time, flush, then append `json.dumps({"done": True}) + "\n"` and flush. The explicit final record stops observation successfully and the final tool result persists the last valid snapshot. Cancellation stops only observation; it does not kill the background job, whose lifecycle remains with the producer/job owner. Missing `done` is a timeout failure (default 60 seconds, maximum 300), never success. Feeds are capped at 1 MiB and 64 KiB per complete or partial record and 48 KiB per validated display snapshot (aggregate larger data); completion rereads the consumed prefix once (at most one additional MiB) to reject rewrites. Completion rejects already-present trailing data, but does not keep watching future appends after `done`. Remove the private feed after its producer and observer finish; the file must be an existing regular file (not FIFO). Malformed JSON, invalid data, empty feeds or truncation fail rather than producing a success card.

Charts are not image generation. For persisted business analytics dashboards, use the owning application's `app-analytics-dashboard` workflow instead.
