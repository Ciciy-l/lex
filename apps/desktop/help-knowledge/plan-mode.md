---
id: plan-mode
title: Reviewing and approving plans
summary: When the agent proposes a plan, approve it, edit it, or send feedback before it proceeds.
---
For larger tasks the agent may first propose a **plan**, shown as a card in the chat. You decide whether to approve, edit, or send feedback before any code runs.

**Card controls:**

- **Approve** — the agent receives the (possibly edited) plan and starts executing.
- **Feedback** — opens a text row; what you write is sent back to the agent as a denial reason. The agent can then propose a revised plan or take a different path.
- **Edit** — open the plan markdown in the card and edit it directly. Edits are auto-saved (debounced) to a plan file on disk; on Approve the edited version is what the agent uses.
- **Cancel** (the toolbar **✕** or **Esc**) — dismiss the review and end the plan loop without approving or sending feedback.
- **Expand / Half / Minimize** — change the card's display size to read or skim it.

**How it appears:**

- The agent emits a `plan_review` event with the plan markdown; the app renders the card in the chat thread and pauses the agent until you respond.

**Notes:**

- For Claude Code, this card is exactly how the SDK's `ExitPlanMode` tool surfaces: the app intercepts that tool call into a `plan_review` interaction and, on Approve, auto-exits plan mode. Lex's renderer ↔ main `resolveInteraction` layer is what renders the card and returns your decision.
- An approved plan card stays in your chat history with an "approved" state; you can scroll back to it.
- If you close the window while a plan card is open, the agent is still paused waiting for your decision — reopen the session to resolve it.
