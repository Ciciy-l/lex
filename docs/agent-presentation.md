# Lex GUI / native TUI implementation contract

Status: implementation in progress for `0.1.7-rc.1`. This document records the
accepted behavior and the evidence required before enabling it. It is not a claim
that any engine has passed native or remote acceptance.

## One running task, two presentations

A task has one authoritative native session, provider route, working directory,
permission policy, event history, and usage ledger. Changing presentation does
not abort, resume, fork, or replace that session. A native frontend may be a
separate process attached to the same engine service; it must not start a second
agent writer. Detaching a view never closes the task.

The GUI continues using Maker session operations and structured events. The TUI
uses the upstream interactive UI and a terminal transport. ANSI output is not
the source of truth for messages, approvals, completion, or accounting. Native
session/turn/message identities reconcile both inputs without text-based dedup.

Engine integration belongs in maker-core. Main owns executable resolution,
credentials, PTYs, device authorization and durable resources. Renderer receives
task-bound handles, never executable paths, arbitrary environment or credentials.

## Native feasibility gate

| Engine | Candidate integration | Required native proof |
| --- | --- | --- |
| Codex | One app-server/thread, protocol GUI client and upstream `--remote` TUI | Multi-client subscriptions, original thread identity, approval routing, existing external-auth/provider isolation |
| Claude Code | Interactive process, local hooks, structured transcript, acknowledged input bridge | Real-time structured events, confirmed sends, stop/approval control, custom provider support without official Remote Control |
| Pi | Interactive process with Lex extension side channel | Structured events and semantic controls while original TUI and native extensions remain functional |
| OMP | Interactive process with engine-specific extension side channel | Same-session events, queue, approvals, original UI; `rpc-ui` alone is not native TUI transport |

Use the current managed binaries, isolated temporary homes and a loopback fake
provider first. Never read the developer's agent home or credentials. Record
binary version, process/session identity, actual hooks/events, accepted messages,
and outcomes separately from assumptions. A successful PTY start alone is not a
successful adapter.

All four must pass before this feature is exposed or the RC is published. A
missing interface keeps the PR in draft and existing GUI behavior intact. Do not
substitute automatic restart, a replica TUI, silent engine exclusion, or blind
paste-and-Enter for a failed gate. Hooks and transcript evidence must actually
support the existing GUI semantics, including streaming and permissions.

## Interaction and remote ownership

- A shared footer contains project/workdir, usage and compact GUI/TUI controls.
  It stays visible in both presentations, with light/dark and narrow layouts.
- Presentation preference belongs to the local device and task. Phone stays GUI;
  different desktops may choose independently. Preserve drafts and view state.
- GUI sends use the existing queue. Raw terminal input has a single controller
  lease; a new lease fences old inputs. Preserve a native editor's pending draft.
- An approval has one identity and one accepted answer. Duplicates, late replies
  and replies from an obsolete runtime generation cannot act on another request.
- Terminal attach/detach, resize, input and output are task-scoped capabilities.
  Structured send/abort/approval retain existing authorization. Output is bounded,
  sequenced and recoverable without replaying unacknowledged input automatically.
- Device Link changes are additive and negotiated. Old clients keep GUI behavior.
  One disconnected peer must not restart shared services or disrupt healthy peers.
- SSH keeps process, native history and cwd on the remote machine, with resize
  and reconnect support. No fallback to a local process or local filesystem.
- Existing running legacy handles are not forcibly migrated. Historical tasks
  remain readable and resume into the new adapter at a normal lifecycle boundary.
- Retire right-workbench Agent CLI quick launch only after left-pane acceptance;
  retain ordinary shell terminals and compatible restoration of saved layouts.

## Incremental delivery and acceptance

Commit contract/probes, each engine adapter, common ownership/recovery, shared
footer/terminal UI, remote integration, old-entry retirement and release inputs
as separate reviewable changes. Each commit requires root
`pnpm test:unit:related`, affected package typechecks and `git commit -s`. Run
focused regressions while iterating; dependency/test-runner changes require the
repository's broader gate. Do not weaken tests to fit an adapter.

Native acceptance covers streaming, tools, queued messages, pending approvals,
abort, attachment, compaction/branch identity, extension UI, provider identity,
usage, view detach, process exit and reconnect. Multi-peer acceptance covers a
phone GUI and desktop TUI simultaneously, controller handover and one silent
peer while another stays healthy. Record Windows UI, macOS/Linux terminal, SSH
and physical-phone results separately; mocks do not establish device acceptance.

Lead develops and audits release assets. Orca Worker merger only receives PR
monitoring, merging and issue-reporting work. The merged commit's own main CI
must pass before a single `v0.1.7-rc.1` tag-triggered release build. Audit the
draft, checksums, actual signing and five-language notices before publishing.
Advance beta feeds only; preserve stable feeds, Latest and the stable website.
Harness latest-download/auto-update policy is a separate PR.

## Upstream reference

VelaTerm reference: `vlinx-io/VelaTerm` at
`afb143c7080c2aad88be36ae8f255e74a58f9ddf`. Its engine switch, process ownership,
PTY exit fencing and native-session recording are useful references. Its
stop/resume handoff is not the normal Lex presentation-switch mechanism. Its
recorded-conversation mobile UI does not by itself prove reliable structured
control, input acceptance or approval synchronization.
