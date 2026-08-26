# lens

Two tools for reading code without reading whole files:

| | |
| --- | --- |
| `read_symbol(file, symbol)` | one function / method / class / type / const, **with its doc comment** and line range |
| `list_symbols(file)` | the top-level outline, no bodies |

Go, TypeScript/JavaScript and Python. No dependencies, no index, no daemon.

## Why this exists rather than pi-lens

pi-lens does far more than this, and we measured what that cost against what we
used.

**Cost**, from its own telemetry (`~/.pi-lens/latency.log`):

| | |
| --- | --- |
| Installed | 22 MB, a 79 155-line bundle |
| Deps | `@ast-grep/{cli,napi}` (native), `vscode-jsonrpc`, tree-sitter grammars fetched by a script, LSP servers installed into `~/.pi-lens/bin` |
| Session start | `extension_loaded` 4.2 s avg ×139, `warmup_total` 6.5 s ×102, `session_start_scan_context_compute` 16.5 s ×26 |
| Agent loop | `loop_block` ×119, averaging **1.7 s** — its own name for blocking the loop |
| State | 20+ files, incl. a 4 MB `latency.log` and a 1.8 MB `sessionstart.log` |

**Use**, across every recorded pi session:

```
read 64 · bash 33 · grep 20 · edit 18 · find 9 · subagent 9 · TodoWrite 7 · ls 6
── pi-lens ──
lsp_diagnostics 4 · lens_diagnostics 2 · module_report 2 · project_report 2 · read_symbol 2
```

12 of ~193 calls. The one worth keeping is reading a symbol instead of a file,
and that needs neither a grammar download nor a language server.

It also **killed two launched agents mid-task**: `saveHistory` is a bare
`mkdirSync` + `writeFileSync` with no `try`/`catch`, called from a debounced
timer, so an `EROFS` under Hive's sandbox became an `uncaughtException` and pi
exited. A metrics cache should not be able to do that, which is the other half
of why this module has no timers and no background work at all.

## What it deliberately does not do

- **LSP diagnostics.** The complicated part, and the least needed: we run the
  real gate (`hive check --step lint`), which is stronger than editor
  diagnostics and already wired up.
- **Complexity / maintainability reports.** Two calls, ever.
- **Reference resolution, import following, identifier ranking.** These want a
  real index. When we need one the answer is an LSP or `ast-grep` as an explicit
  tool — not a bigger regex here.

## How it works, and where it will be wrong

`symbols.ts` is pure and dependency-free. It finds declarations with
line-anchored patterns (so a *call* to `foo(` never matches a declaration of
`foo`), then takes the body by scanning delimiters — skipping strings, template
literals and comments, because a `}` inside `"}"` or after `//` is the likeliest
way a brace counter silently returns the wrong span. Python ends a block on
indentation, and blank lines never end one.

Known limits, stated rather than discovered:

- A declaration form not in the pattern list is **not found**, and the tool says
  so and points at `grep` — it never guesses a span.
- Multiple declarations of a name all come back, in file order. That is
  deliberate: a name is often both an interface and its implementations, and the
  contract is usually the most useful one.
- An unterminated block runs to end of file.
- It has no idea about macros, code generation or conditional compilation.

Verified against real files in this workspace (Go and TS, 8–82 line symbols):
every extracted span was brace-balanced and started at the doc comment.


## The escape hatch, taken (HIV-1565)

The rule above says real reference resolution belongs in an **explicit LSP-backed
tool, not a larger regex**. `rename_symbol` and `move_file` are that tool, and
they honour the constraint that mattered: **no bundled LSP infrastructure.** They
speak to the TARGET PROJECT's own `node_modules/typescript/bin/tsserver`, spawned
per call and killed after — no daemon, no state directory, no grammar downloads,
no session-start cost, and the project's own TypeScript version answers. A
project without a local tsserver gets a clean refusal, not a weaker fallback.

They exist because a regex cannot reach the case: with a barrel re-export the
file that must change does not contain the symbol in a form grep can match, so a
hand-rolled rename yields a diff that typechecks locally and breaks the
whole-project gate.

The regex tools (`read_symbol`, `list_symbols`) are unchanged and remain the
default for reading — they need no project, no install, and no subprocess.
