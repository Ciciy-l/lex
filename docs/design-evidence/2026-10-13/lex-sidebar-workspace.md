# Lex sidebar workspace changes

- Base: `3ae734a8a71b10e05dd7df3d9477c22498883cfb` (PR #74 merge).
- Branch: `feat/lex-sidebar-workspace`; the PR's final head identifies this change.
- Scope: desktop main and detached sidebar; local, SSH and Device Link read paths.
- User-approved visible change: multi-repository dropdown, single-row Graph,
  A/M/D/R/U file decorations, first-worker collaboration enable, compact empty
  content pane with expanded-width restoration.
- Design: `DESIGN.md` §4, §5, §10 “Git File Status and Sidebar Navigation”,
  “Git Graph Ancestry Colors”; five locales and existing semantic tokens.

## Reference decisions

The analysis consulted VS Code Git's decoration provider and the Git Graph
extension's README/repository manager:

- https://github.com/microsoft/vscode/blob/main/extensions/git/src/decorationProvider.ts
- https://github.com/mhutchie/vscode-git-graph/blob/master/README.md
- https://github.com/mhutchie/vscode-git-graph/blob/master/src/repoManager.ts

Adopted their per-repository selection/state projection and bounded discovery
patterns. Lex retains its Git CLI, diff reader, graph topology and permission
boundaries. Git commit identifiers are short SHA, not MD5. Discovery supports
`.git` directories/files, preserves an enclosing repository, skips common generated
directories, and reports partial scans. Explicit relative paths support deeper
repositories. Controlled-device write operations remain unavailable; old devices
retain default-repository Review until upgraded.

## Verification record

No local tests, typecheck, build, or application restart: the user explicitly
requires CI-only execution. New regression cases are provided for CI, including
repository identity/isolation, SSH ownership, removed-file overlays, remote
capability downgrade, first Worker creation, and detached width persistence.
Local work includes source/diff review, formatting of touched files, parsing all
five locale JSON files, and generating the 52-surface inventory with
`node scripts/design-inventory.mjs` (manual sections retained). `git diff --check`
checks whitespace; none of these is compilation or runtime evidence. CI results will be recorded in the PR by
the existing merger Orca Worker.

No real-app Light/Dark screenshots, remote UI interaction, filesystem performance
measurements, keyboard walkthrough, or installed-device upgrade evidence has been
collected. Semantic-token implementation is not claimed as visual acceptance.

## Manual acceptance path

1. Open a non-Git workspace containing two repositories and a worktree/submodule;
   switch the repository dropdown and confirm status, history and diffs stay scoped.
2. Repeat on an SSH task and a controlled-device task; disconnect/reconnect and
   confirm there is no local fallback. An older device shows its default Review.
3. Add/modify/delete/rename a file. Confirm tree and recent commits show the status;
   expand a removed directory and open a deleted-file diff without filesystem writes.
4. Open collaboration from the sidebar on a task with no team; create one Worker
   and confirm focus, permission choice, policy rejection and duplicate-click handling.
5. Open/close the last content tab in embedded and detached modes, including restart,
   maximize/fullscreen and task switching. Expanded widths should be retained.
6. Check Light/Dark and narrow history: badges precede an ellipsized subject; author,
   date and SHA stay on that row; horizontal scroll and keyboard navigation work.
