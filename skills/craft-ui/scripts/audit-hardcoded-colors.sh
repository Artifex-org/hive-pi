#!/usr/bin/env bash
# craft-ui validator: flags hardcoded colors that bypass the project's token system.
# Usage: audit-hardcoded-colors.sh <file-or-dir> [more paths...]
# Exit 0 = clean, 1 = findings, 2 = usage error.
#
# Flags:
#   - raw Tailwind palette utilities: bg-red-500, text-blue-600, border-zinc-300, ...
#   - hex color literals (#fff, #ffffff, #ffffffcc) in tsx/jsx/ts/js/css/html/vue/svelte
# Skips: token definition files are expected to contain raw values — pass only
# component/product paths, not the theme/token source itself.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $(basename "$0") <file-or-dir> [more paths...]" >&2
  exit 2
fi

PALETTE='(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)'
UTIL_RE="(^|[\"'\`[:space:]:])(bg|text|border|ring|fill|stroke|outline|decoration|divide|shadow|accent|caret|from|via|to)-${PALETTE}-[0-9]{2,3}([/[:space:]\"'\`]|$)"
HEX_RE='#[0-9a-fA-F]{3,8}\b'
INCLUDES=(--include='*.tsx' --include='*.jsx' --include='*.ts' --include='*.js' --include='*.css' --include='*.html' --include='*.vue' --include='*.svelte')
EXCLUDES=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.git --exclude='*.test.*' --exclude='*.stories.*' --exclude='*.gen.*')

status=0

findings=$(grep -rnHE "${INCLUDES[@]}" "${EXCLUDES[@]}" "$UTIL_RE" "$@" 2>/dev/null || true)
if [ -n "$findings" ]; then
  echo "== Raw Tailwind palette utilities (use design tokens instead) =="
  echo "$findings"
  status=1
fi

# Hex literals: skip lines that are clearly token definitions or fallbacks inside var()
hexes=$(grep -rnHE "${INCLUDES[@]}" "${EXCLUDES[@]}" "$HEX_RE" "$@" 2>/dev/null | grep -vE '(\.css:[0-9]+:.*--[a-z0-9-]+:[[:space:]]*#)|var\(--[a-z0-9-]+,[[:space:]]*#' || true)
if [ -n "$hexes" ]; then
  echo "== Hex color literals (use design tokens; fallbacks belong inside var(--x, #…)) =="
  echo "$hexes"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "clean: no hardcoded colors found in: $*"
fi
exit "$status"
