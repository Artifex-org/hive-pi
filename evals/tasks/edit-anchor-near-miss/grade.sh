#!/usr/bin/env bash
# Exit code IS the verdict: 0 = pass, non-zero distinguishes failure modes.
set -u
grep -qx '# Linear Ticket Manager' /work/SKILL.md || { echo "heading not updated"; exit 1; }
grep -q 'Use this skill to file and update Linear tickets.' /work/SKILL.md || { echo "body was damaged"; exit 2; }
grep -q '1. Find the team.' /work/SKILL.md || { echo "steps were damaged"; exit 3; }
exit 0
