---
id: memory
title: Memory across conversations
summary: The "Lex" master switch turns on shared cross-agent memory (default on); when off, each agent uses its own native memory — all in Settings > Personalization > Memory.
tab: personalization
---
Memory lets the agents carry context across your conversations — facts about you, your projects, and how you like to work. There are two kinds, and one master switch chooses between them.

**Where it lives:**

- Settings > Personalization > Memory.

**The "Lex" master switch (default ON):**

- Turning **Lex** on enables a **shared, cross-agent memory** scoped to each working directory — Claude Code, Codex, and Pi sessions in the same directory draw on the same memory.
- While it's on, the per-agent native toggles below are **disabled / grayed out**, because the shared memory supersedes them.
- It's **on by default** for new installs.

**Per-agent native memory (used when the master switch is OFF):**

- When Lex is off, each agent falls back to **its own native memory** — so turning the master off does not mean "no memory," it means each agent remembers things its own way.
- Separate toggles let you enable / disable native memory for **Claude Code** and **Codex** independently (these are only interactive while the master switch is off).

**Resetting:**

- **Per-agent reset** clears a single agent's native memory.
- **Reset all Lex memory** clears the shared cross-agent memory for every working directory.
- A section-level **reset to defaults** restores the switches themselves.
- Resets ask for confirmation and aren't undoable.

**What memory is, what it isn't:**

- It's the agents' **long-term memory across sessions** — notes about you and your projects.
- It's **not** the in-session chat history (that's always persisted to the session itself).
- It's **not** your Personalization custom instructions (those are standing instructions you write; memory is what the agents record about you).

**Notes:**

- Changes take effect on the **next** chat / agent turn — toggling mid-conversation doesn't retroactively scrub current context.
- Memory is stored locally and does not migrate if you change machines or wipe the app's user data.
