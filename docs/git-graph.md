# Lex Git Graph

The Git tool navigator opens a singleton Git Graph in the existing content-tab
strip. It does not add a second content region. Its session/workdir comes from
the owning content host (the Lead in an Orca workflow), never the selected Worker.
The implementation and SVG lane layout are original Lex code; no code or assets
from the third-party VS Code Git Graph extension are used.

## Read-only scope

- The graph and exact comparison IPCs require a trusted app renderer, a bounded
  session ID, and an authoritative local session row. SSH sessions are rejected
  before scope resolution. Device Link does not expose these operations; the UI
  also refuses unresolved device ownership.
- No checkout, reset, branch/tag/stash modification, merge, or push is added.
  Existing change review and its write safeguards are unchanged.
- Local navigation reads status without loading working-tree patches. Device
  navigation keeps the existing read transport rather than adding remote ops.

## History and comparisons

- History starts at 100 commits, extending a date-ordered, child-before-parent
  prefix by 100 up to 1,000. Refresh and load-more resample refs/HEAD, then pass
  their fixed commit OIDs to Git. Results replace the prefix atomically instead
  of appending potentially shifted pages. Search highlights the loaded rows so
  ancestry edges are not broken by hiding intermediate commits.
- Local branches, remote refs, commit tags (including annotated tags), and the
  current stash tip are displayed. Stash reflog history is not included.
- Reference enumeration is limited to 256 refs and 4 MiB; log output is limited
  to 4 MiB and 15 seconds. Repositories exceeding these limits fail explicitly
  rather than silently presenting incomplete ancestry. There is no background
  fetch. Current-branch mode follows the resolved HEAD, including detached HEAD.
- Selecting a commit shows its author/time, full OID and parents, with a link to
  existing commit review (first-parent diff, or the root commit's changes).
- Explicit comparison snapshots both selected labels and full commit OIDs:
  fromRef/fromOid → toRef/toOid. Subsequent ref movement does not retarget it.
  Diff reads compare the two exact trees, reuse capped branch-diff parsing and
  the existing read-only diff renderer, and disable external diff/textconv.
  Existing branch-relative review continues to use merge-base semantics.
- Large comparisons show an explicit preview-limit notice and available file
  summaries. Graph comparison does not bypass existing caps with per-file loads.

Refresh uses a 250 ms debounce, one in-flight request and one trailing refresh,
with focus/file-save/Git-change events and a visible-tab 15-second fallback.
The previous successful list stays visible during refresh. Switching owning
session/workdir invalidates pending UI results and comparison selections.

Tests cover payload guards, local-only scope resolution, fixed roots/OIDs,
history/ref parsing and limits, lane layout, refresh serialization, content-tab
routing, context changes, and exact-versus-merge-base differences using real Git
in isolated test repositories.

## Visual redesign (2026-09-09)

The original initial layout allowed the widest ancestry row to determine every
row's graph width. Large merges pushed subjects off-screen. The revised layout
keeps ancestry at 16–88 px (at most six lanes visible). Arrow controls pan only
the graph viewport; they do not filter or reorder commits. Selection automatically
brings its lane into view. First-parent color follows ancestry rather than the
screen column, so reusing or shifting a column does not recolor that path.

The subject is the primary row label, followed by bounded short reference badges.
Full subjects, refs, author names, OIDs, and local timestamps remain available in
tooltips or selected-commit/explicit-comparison details. Each row displays the
author timestamp already supplied by the API: month/day and local hour/minute,
with full local date/year in the tooltip and ISO datetime for assistive tooling.
At widths below 640 px, date/hash are inline metadata. At wider widths they have
separate columns, and the author becomes its own column from 880 px. Narrow rows
are 52 px; wide rows are 36 px. The list takes the available height rather than a
fixed fraction of the window. Arrow keys, Home, and End move through commits.

Normal chrome stays neutral. The six new git-graph-lane tokens are categorical
data visualization, not status colors. Their light/dark defaults and scope are
documented in DESIGN.md; the existing process-category tokens are not repurposed.
Tests require 3:1 line/surface contrast across every built-in theme. External
themes retain their stored settings and receive the appropriate base-mode defaults.

The Git navigator uses compact neutral icon/text controls and one repository/
branch header. Staged/unstaged headers retain native disclosure behavior with
independent icon-only Review actions outside the summary. Comparison is collapsed
until explicitly opened or a base/target is selected. There are no new Git actions.

### Reference study and original choices

With explicit Lead permission, the local VS Code Git Graph README and column
handling references were inspected only to understand information architecture:
bounded/resizable columns, separate author/date/hash metadata, and contextual
commit/comparison detail. No upstream implementation, strings, CSS, algorithms,
assets, or branded material were copied or adapted. Lex uses its own fixed-OID
flow, original compact viewport/lane layout, existing content host, and theme tokens.

Public first-party design references consulted:

- https://help.gitkraken.com/gitkraken-desktop/interface/ — distinguishes repository
  navigation, graph columns (including author/date/SHA), and contextual details.
- https://git-fork.com/ — separates commit history, working-directory changes,
  and diff views. Lex retains that separation without adding their mutation tools.

### Reproducible visual checks

From the repository root, run:

    pnpm --filter desktop exec node src/renderer/features/right-sidebar/plugins/git-graph/__tests__/visual-check.mjs

This starts an ephemeral loopback Vite server and a fresh headless Chromium
profile, rendering the actual Graph and navigator components against fake read-only
data. It does not start/restart Electron, query Git, or access stored credentials.
Use GIT_GRAPH_BROWSER_PATH if the browser is not at a discovered standard path.
Optionally set GIT_GRAPH_SCREENSHOT_DIR to an existing output directory.

Checks cover light/dark themes, 320/360/920 px graph panels, bounded ancestry,
readable subject width, visible timestamps, absence of horizontal row overflow,
multiple computed lane colors, independent native disclosures, keyboard focus,
and contextual comparison. These source-backed browser screenshots are Level 1
evidence, not a replacement for Level 2 visual approval in the real desktop host.
The Lead should still inspect the real content tab with a representative repository.

### Merge-lane follow-up

The graph reader now requests Git date-order instead of topo-order. The former
interleaves independent histories by committer timestamp while still placing
children before their parents; it is also the reference extension's default.
The row's displayed timestamp remains the author timestamp as before. No parents
are filtered and no first-parent-only traversal is introduced. Different ref sets
and genuine concurrent histories can still require different numbers of lanes;
date ordering is not a universal promise of fewer lanes.

The original Lex allocator now reuses vacant columns rather than inserting and
shifting every later column. An unloaded parent no longer reserves a lane through
all remaining rows: it has a short dashed continuation spur with a localized
explanation. Loading its commit replaces that boundary marker with the actual
ancestry path. Multiple unknown parents remain visible in commit details, while
the continuation marker is only an indication that this loaded prefix is incomplete.
This is not a graph-edge simplification or a claim that the commit is a root.

The recent-history navigator shows commit subjects without hash prefixes. Full
OID remains in the tooltip and all review/file navigation still uses the OID.
Tests cover repeated dated merges, child-before-parent order, bounded prefixes,
vacant lane reuse, unloaded-parent boundaries and subsequent expansion, and
unchanged OID-based navigation. The screenshot repository was subsequently located
at F:/Projects/GPT-Image2-Codex and inspected using read-only Git commands.

### Automatic loading

Renderer history uses the backend's original date-ordered prefix without a second
sorting pass. Closed columns compact left while remaining path colors persist.

The manual load-more button is removed. Within 180 px of the history viewport's
bottom, the next bounded batch is requested through the serialized refresh queue.
The visible commit OID and its pixel offset anchor the viewport across display
reordering. Growth is blocked while a request is pending, after failure, for hidden
tabs and when no more history exists. The existing 1,000-commit safety limit is
retained with a passive limit notice. Refresh retries failed reads; scrolling does
not create an uncontrolled retry loop. Screenshots of the reference extension are
design targets, not proof that its implementation or repository was reproduced.
