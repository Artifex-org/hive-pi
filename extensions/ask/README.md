# ask — in-house ask_user_question (HIV-1220)

Replaces `@juicesharp/rpiv-ask-user-question` (4.8k LOC, 39 files) with
~700. Same tool name, bottom-anchored full-width overlay (the rpiv
placement), reducer-driven so every interaction rule is a unit test.

The interaction spec, each rule with a measured source (HIV-1218 research):

- **Answers keyed by stable snake_case `id`, values are string arrays**
  (Codex `request_user_input` — ids survive question rewording; arrays let
  labels and notes compose).
- **Digits 1-9 = jump + commit + advance** in one press (Codex). No
  multi-digit buffer needed: the schema caps options at 4.
- **Typing any printable lands in the text field** — no mode switch (Codex).
  One text row per question serves as **Other** (nothing selected → the text
  IS the answer) and as a **note** (something selected → appended): Codex's
  notes and Claude Code's Other unified, because "option B, but only for the
  API layer" is the most common real answer.
- **Recommended option first** with "(Recommended)" and the cursor starts on
  it → Enter-Enter fast path (Claude Code convention).
- **Auto-advance on single-select commit; auto-submit on the last commit
  when everything is answered** (Claude Code — no review screen). Submission
  never skips an unanswered question silently — it jumps there instead.
- **Contextual Esc, never turn-killing from text entry** (Codex; CC shipped
  that as a bug): text → back to options; options → arm, second Esc
  dismisses (the model is told the user declined and not to re-ask).
- **Schema forbids an "Other"/"None of the above" option** — the client
  always provides the free-text row (CC).
- **`details` envelope** `{questions, answers|dismissed|no_ui}` for the Hive
  request/question widget (HIV-1201), and a deck `ask` section with
  `waitingOnInput` while pending (HIV-1219 attention segment).
- **Fallbacks**: rpc mode walks `ui.select`/`ui.input` sequentially (the RPC
  sub-protocol has no custom components); headless modes return a `no_ui`
  envelope telling the model to ask in prose rather than hanging a factory
  run on a modal.

Deliberately absent (decisions, not omissions): option previews, overlay
collapse, vim j/k navigation (typing-first wins), idle auto-continue
timeouts, i18n.
