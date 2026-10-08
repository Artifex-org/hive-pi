---
name: browser-use
description: How a Hive agent drives its session browser (browser_navigate, browser_snapshot, browser_click, browser_type, browser_wait_for, browser_screenshot, browser_console, browser_evaluate) and shares what it sees. Load before any task that opens a web page — verifying a UI change, reproducing a UI bug, checking a dev server, taking before/after screenshots for a PR, recording or running a Playwright flow. Covers the snapshot → act → verify loop, selectors, waiting, the console, labelled screenshots (posted to the Hive chat and its Media section automatically), send_attachment for other evidence, gh --attach for PRs, flows, and the browser's limits.
---

# browser-use — drive the session browser, show the operator

You have one headless Chromium per session (1280×800, one page), started on
your first browser call. It runs where you run, so it reaches your own loopback
dev server directly. The operator follows along: the desktop app shows the live
page, and every screenshot you label lands in the Hive chat and its **Media**
section as you take it.

## Tool names

| Harness | Names | Before the first call |
|---|---|---|
| pi | `browser_navigate`, `browser_snapshot`, … | deferred: `load_tools` them first |
| Claude Code | `mcp__hive-pi__browser_navigate`, … | load schemas with `ToolSearch` (`select:mcp__hive-pi__browser_navigate,…`) |

The tools, their wording and their limits are identical in both harnesses.

## The loop: snapshot, act, verify

1. **Get a page up.** Start the dev server detached (the project's AGENTS.md
   names the command and port), then `report_dev_server` with its explicit
   loopback URL (`http://127.0.0.1:5173`) so Hive shows it as a resource.
2. **`browser_navigate`** returns the page's aria outline. Read it before you
   act: it is the ground truth for what is on the page.
3. **Act with selectors taken from the outline.** Prefer role and name:
   `role=button[name="Save"]`, `role=textbox[name="Email"]`, then `text=Save`,
   then CSS. Never guess a selector you have not seen in a snapshot.
   `browser_click` and `browser_type` return the new outline, so re-read it.
   After a navigation the old selectors are stale; snapshot again.
4. **Wait on a condition, never on time.** Use `browser_wait_for` with a
   selector (`state: "hidden"` for spinners and toasts). Do not `sleep`.
5. **Verify.**
   - Read the outline (`browser_snapshot`).
   - Read state with `browser_evaluate`, e.g. `document.querySelectorAll('.row').length`.
   - Check `browser_console` after a navigation or submit. A page that looks
     right with an uncaught error in the console is not working.

`browser_evaluate` is for reading. Do not click or fill through it: that skips
the real events, so the test proves nothing about the UI.

## Screenshots: label what the operator should see

`browser_screenshot` saves a PNG, returns it to you inline, and records it in
`pr-attachments.json`. Whether to pass `label` is the real choice:

- **With a `label`**, the shot is evidence. It is posted to the Hive chat (and
  its Media section) automatically, with the label and page URL as the caption.
  Do not also `send_attachment` it.
  - `before`: the state before a UI change. Take it before your first edit to a
    UI file. On pi, with a page already open, the harness blocks that edit once
    if you have not.
  - `after`: the same view once the change works.
  - Anything else short and specific: `repro-500-on-save`, `empty-state`,
    `mobile-nav-open`.
- **Without a label**, the shot is for you: checking layout, reading a chart,
  debugging. It stays out of the chat.

Label a shot when the operator would want to see it without asking:

- before and after of every user-visible change
- the reproduction of a UI bug, and the fixed state
- a blocking error page, or a state you need a decision on
- the finished feature on the screen where it lives

Do not label routine navigation, a half-loaded page, or anything showing
credentials, tokens or personal data. A labelled shot leaves your machine.
Wait for the page to settle before a labelled shot, and use `full_page: true`
when the change is below the fold.

## Other evidence: `send_attachment`

For a file that is not a labelled screenshot (a recording, an exported
report, a generated image, an unlabelled shot you later decide matters), call
`send_attachment` with the path and a one-line caption. It accepts files under
your working directory or your screenshot directory, up to 5 MiB. It lands in
the chat and the Media section. It is not a PR attachment.

## Putting screenshots on the PR

Attach the labelled shots with `gh` ≥ 2.99, single-quoting each value, since
the alt text is prose:

```sh
gh pr create --title '…' --body-file body.md \
  --attach '/tmp/pi-browser-<session>/shot-1712345678901.png#Orders list before' \
  --attach '/tmp/pi-browser-<session>/shot-1712345699999.png#Orders list after'
```

The result of `browser_screenshot` gives the exact path. In a Factory run the
delivery step attaches every manifest entry by itself, unlabelled shots
included, so keep throwaway shots few. On a workstation you pass `--attach`.

## Flows: make a check repeatable

- `record_playwright_flow {action:"start"}`, drive the page with the browser
  tools, then `{action:"stop"}`. That returns Playwright source.
- Replay it with `run_playwright_flow_source` against your loopback base URL.
- Save it with Hive's `save_agent_flow` so a teammate or a later session can
  run it with `run_saved_agent_flow`. Poll with the same `call_id`; a queued or
  deferred run is not a pass.

## Limits and boundaries

- Navigation times out after 20 s, actions after 10 s, a wait after 60 s.
  Snapshots are cut at 30,000 characters, so narrow with `browser_evaluate` on
  large pages.
- Loopback is session-local in a sandbox. A teammate's `127.0.0.1` is not
  yours, and yours is not theirs; share through a saved flow, never a URL.
- External hosts go through the sandbox's domain allowlist. A blocked host is
  a missing grant, not a page bug.
- Never type real credentials into a page. Use the project's seeded test users.
- A call stuck past its bound closes the browser, and the next call relaunches
  it. Navigate again; the old page state is gone.

## Reporting

In your final message, say what you checked in the browser and what you saw.
Refer to the labelled screenshots by label; the operator has them in Media.
"Verified in the browser" without a snapshot, an evaluate result or a
screenshot behind it is not evidence.
