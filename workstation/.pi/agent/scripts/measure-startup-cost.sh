#!/usr/bin/env bash
# What the first turn of a session costs, measured (HIV-1969).
#
# The startup levers in this harness are argued about in seconds that nobody
# re-measures: `brief` blocks the first turn by design, the MCP adapter's
# lifecycle decides whether the first tool call pays a connect, and both numbers
# move when a pin moves. This runs the same prompt through two arms, alternating
# so a drifting provider latency hits both equally, and prints the delta.
#
#   ./measure-startup-cost.sh                  # brief on vs off, 3 runs each
#   RUNS=5 ./measure-startup-cost.sh
#   PROMPT="..." ./measure-startup-cost.sh
#
# THE TRAP THIS SCRIPT EXISTS TO AVOID. The first attempt at this measurement
# used the prompt "Explain in one sentence what the readiness extension is for"
# and found brief cost exactly nothing — because brief's own `looksTaskLike()`
# gate had suppressed it. A prompt must be >=40 chars AND carry a ticket key, a
# file path with a known extension, or one of its TASK_VERBs. The default below
# satisfies all three tests deliberately; change it with care, and if an arm
# comes back identical, check `PI_BRIEF_*` and the gate before believing it.
#
# Measured 2026-08-16 on this workstation (pi 0.84.1, gpt-5.6-terra):
#   brief on  27.5s mean (19.4 / 33.1 / 29.9)
#   brief off 10.9s mean (11.3 / 11.2 / 10.1)
#   → brief costs ~16.6s, ~2.5x, on the first turn. Note this is well under the
#     49.5-72.5s quoted in brief/config.ts: those were SEQUENTIAL passes on the
#     fleet's low tier, this is the lane-parallel path.
set -u

RUNS="${RUNS:-3}"
PROMPT="${PROMPT:-Investigate why extensions/readiness/state.ts sorts results the way it does, and answer in one sentence. Do not edit anything.}"
OUT="${OUT:-$(mktemp -t startup-timings-XXXXXX.txt)}"
: > "$OUT"

run() {
	local arm="$1" idx="$2" start end
	start=$(date +%s%3N)
	if [ "$arm" = "off" ]; then
		PI_BRIEF_AUTO=0 pi -p "$PROMPT" >/dev/null 2>&1
	else
		pi -p "$PROMPT" >/dev/null 2>&1
	fi
	end=$(date +%s%3N)
	echo "brief-$arm run$idx $(( end - start ))ms" | tee -a "$OUT"
}

for ((i = 1; i <= RUNS; i++)); do
	run on "$i"
	run off "$i"
done

echo "--- summary ---" | tee -a "$OUT"
for arm in on off; do
	awk -v a="brief-$arm" '$1==a {gsub(/ms/,"",$3); s+=$3; n++} END {if(n) printf "%s mean %.0fms over %d runs\n", a, s/n, n}' "$OUT" | tee -a "$OUT"
done
echo "timings: $OUT"
