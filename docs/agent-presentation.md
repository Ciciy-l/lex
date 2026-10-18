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

## Claude native gate: Windows, 2026-10-18

The opt-in probe is `node scripts/agent-presentation/claude-native-probe.mjs`.
Additional scenarios are `--scenario=permission`, `--scenario=abort`, and
`--scenario=stream-option`. The last scenario intentionally checks a rejected
native option combination and exits nonzero. Pure fixture checks run with
`node --test scripts/agent-presentation/claude-native-probe.test.mjs`.

Tested managed Claude Code `2.1.296`, Windows x64, with a fresh temporary home,
empty trusted fixture directory and loopback Anthropic-compatible fake provider.
No real credentials, cloud Remote Control, binary patches or version changes.
All final probe processes exited and their temporary profiles were removed.

Observed facts:

- Two successive inputs received `UserPromptSubmit` hooks under the same native
  session and process. The second input was diagnostic bracketed paste, not a
  proven product input queue or an exactly-once transport.
- First main response: first provider delta at 1032 ms, stream completed at
  4034 ms, first completed assistant transcript observed at 4202 ms. No partial
  assistant transcript appeared during the intentionally delayed stream. The
  second response likewise appeared in the transcript after completion.
- Native title generation also issued provider requests. The probe distinguishes
  these from the main conversation. Observing all proxy response bytes does not
  by itself identify which events belong in the task's GUI or usage ledger.
- `PreToolUse` and `PermissionRequest` arrived for a synthetic Write. A denial
  returned through the permission hook reached the native UI and prevented the
  file write. The native permission dialog was visible while the hook waited.
  Multiple-controller answer races and full approval identity remain unproven.
- Native Escape closed the deliberately open main provider response while the
  CLI process stayed alive. This proves native keyboard interruption, not a
  complete structured interrupt/acknowledgment protocol.
- Requesting partial JSON events in interactive mode exited with
  `Error: --include-partial-messages requires --print and --output-format=stream-json.`
  The existing SDK stream uses non-interactive mode.

The hooks/transcript candidate therefore has **not passed the continuous dual
presentation gate**: live structured output and reliable editor-aware semantic
input are still missing. This is a finding about the tested integration, not a
claim that every possible future Claude integration is impossible. Do not ship
final-message-only GUI synchronization as equivalent to existing streaming GUI.
Other engine findings are recorded independently below; one successful engine
does not establish the missing Claude interfaces.

Raw fixture-only evidence is under the workspace's sibling `ci-logs/` directory
as `claude-native-presentation-*-final.json`; it is not shipped with the product.
Earlier setup attempts are retained separately and are not counted as passing
native capability tests. Product adapters/UI and RC publication remain gated.

## Codex native gate: Windows, 2026-10-18

Run `node scripts/agent-presentation/codex-native-probe.mjs` explicitly. The
managed `0.162.1` binary owns one app-server and conversation. A JSON client and
the real `codex resume <id> --remote ...` terminal connect concurrently over
authenticated loopback WebSockets. Only synthetic prompts and a loopback fake
Responses provider are used, with isolated homes. The transparent observation
proxy forwards original TUI protocol frames; it does not emulate the TUI.

The final experiment proved:

- Both clients receive live structured deltas before the first provider response
  completes; the original terminal also renders the response.
- An input submitted through the original terminal editor enters the same native
  thread and is observed by the JSON client. A subsequent JSON input enters that
  thread too. The thread contains exactly three completed main turns.
- Disconnecting the TUI during the third response, and refusing its reconnect,
  leaves the original app-server alive and the original turn completes in GUI.
- The TUI calls `thread/resume` to subscribe to the already loaded thread. In this
  experiment it does not restart the agent, replace the process, fork history or
  replay the running turn. The native protocol method name is not evidence of a
  stop/resume handoff.
- Native title generation creates an ephemeral auxiliary thread. The probe
  separately classifies that request; it does not count it as a main turn.

The first setup attempt used incompatible `--no-daemon` with `--remote`; the CLI
rejected it before connecting. The corrected final run has seven positive
checks, confirmed native exits and temporary-profile cleanup. A native warning
about helper aliases in temporary directories remains; no shell/tool execution
is claimed. Raw evidence: `ci-logs/codex-native-presentation-final.json` outside
the repository. Pure isolation/classification checks are in the adjacent test.

This establishes a viable continuous dual-frontend route, **not a complete Lex
adapter**. Approval races, unified input queue, control leases, configuration
ownership, tools, attachments, compaction, SSH, Device Link and other OSes remain
unverified. The official [app-server documentation](https://learn.chatgpt.com/docs/app-server)
labels WebSocket transport experimental and unsupported; native version and
protocol compatibility must therefore remain explicit product gates.

## Pi and OMP native gates: Windows, 2026-10-18

Run `node scripts/agent-presentation/extension-native-probe.mjs --engine=pi` or
`--engine=omp` explicitly. Tested managed Pi `1.2.0` and OMP `18.10.4` inside
their original interactive terminal with a fixture-only native extension. The
extension uses the engine's semantic `sendUserMessage`, events and `ctx.abort`;
it does not paste GUI prompts into the terminal. An authenticated loopback
side channel transports fixture commands/events, alongside a fake Anthropic
provider. Only the original terminal input case uses PTY keyboard input.

Both final runs establish six facts:

- Structured `message_update` text deltas arrive before provider completion.
- All observed extension events retain one native session ID and process ID.
- A GUI follow-up submitted during generation executes after the first reply.
- A message from the original terminal editor appears in structured user events.
- The original native terminal displays the generated response.
- Semantic abort closes an intentionally unfinished provider response; the
  process remains alive and reports idle with no pending input.

Provider stream completion is not native completion. The probe waits for fresh
idle/queue status acknowledgments rather than assuming the first idle query
must already be true. Pi also emits `agent_settled`; that remains the production
finality boundary. OMP native metadata prefixes are preserved by the engine and
excluded only from fixture-prompt classification, not rewritten in production.

OMP requires its synthetic provider in `models.yml` before CLI model selection;
registering it from the extension factory alone was too late. Its isolated
`config.yml` disables setup wizard/splash/update checks for this experiment.
Before this fixture setup was corrected, four exploratory runs entered native
provider onboarding and opened browsers using the temporary profile. No login
was completed. The task-owned browser roots were identified by their children’s
exact temporary-profile paths and closed. The subsequent recursive cleanup was
denied by automatic approval policy; four residual fixture directories remain
recorded in the external checkpoint. Do not describe those exploratory runs as
pure loopback successes. Final runs did not enter onboarding, both exited and
removed their own temporary profiles. Earlier failure evidence is retained.

Raw final evidence is `ci-logs/pi-native-presentation-final2.json` and
`ci-logs/omp-native-presentation-final2.json`, outside the repository. Pure
fixture-classification and incremental terminal-observation tests are adjacent
to the probes. The terminal helper only filters diagnostic text; it is not an
ANSI screen emulator or a source of authoritative conversation events.

These results support the native extension route, **not full production
adapters**. Tool permission races, extension UI preservation, queued draft
ownership, attachment/compaction/history mapping, existing Lex bridge behavior,
backpressure/reconnect, Device Link, SSH and non-Windows platforms remain
unverified. The test extension awaits local event delivery for evidence; a
production bridge must not let a slow or absent GUI stall the native engine.
All-four-engine exposure and RC gates remain closed because the Claude native
interface gap above is unresolved.

## Upstream reference

VelaTerm reference: `vlinx-io/VelaTerm` at
`afb143c7080c2aad88be36ae8f255e74a58f9ddf`. Its engine switch, process ownership,
PTY exit fencing and native-session recording are useful references. Its
stop/resume handoff is not the normal Lex presentation-switch mechanism. Its
recorded-conversation mobile UI does not by itself prove reliable structured
control, input acceptance or approval synchronization.
