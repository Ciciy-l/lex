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

GUI messages submitted through Lex's built-in Claude bridge show the user's
original input, without the internal plugin badge or Claude's plugin envelope.
Keep the native UUID, structured origin and unmodified native message internally.
This exception requires a trusted bridge submission bound to that native row;
matching a plugin-looking string or name prefix is insufficient. Other installed
Claude plugins keep their source labels and content, including after reload or
remote synchronization. This is a display projection, not a change to Claude's
model input, native transcript or original TUI.

Engine integration belongs in maker-core. Main owns executable resolution,
credentials, PTYs, device authorization and durable resources. Renderer receives
task-bound handles, never executable paths, arbitrary environment or credentials.

## Native feasibility gate

| Engine | Candidate integration | Required native proof |
| --- | --- | --- |
| Codex | One app-server/thread, protocol GUI client and upstream `--remote` TUI | Multi-client subscriptions, original thread identity, approval routing, existing external-auth/provider isolation |
| Claude Code | Interactive process with an official Mods semantic side channel | Real-time structured events, queued sends without draft loss, stop/approval control, custom provider support without official Remote Control |
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
The subsequent Mods experiment below supplies live output and semantic input
through a different official interface; it does not change these old results.

Raw fixture-only evidence is under the workspace's sibling `ci-logs/` directory
as `claude-native-presentation-*-final.json`; it is not shipped with the product.
Earlier setup attempts are retained separately and are not counted as passing
native capability tests. Product adapters/UI and RC publication remain gated.

## Claude Mods native gate: Windows, 2026-10-18

The preferred candidate is now an official hooks-module plugin, loaded into the
original interactive CLI with its documented --plugin-dir option. Reference:
[official Mods README](https://github.com/anthropics/claude-code/blob/dd6bee38458cc3e6dc5f2b16eca1f0f364619ad8/mods/README.md).
Mods remain Early Access and load only where function hooks are enabled. The
probe does not enable hidden flags, override policy, patch binaries or upgrade
the managed runtime. The public declarations describe 2.1.296/2.1.302, but both
have an older generated header; runtime evidence takes precedence.

Run the isolated probe explicitly:

~~~sh
node scripts/agent-presentation/claude-mods-probe.mjs
node scripts/agent-presentation/claude-mods-probe.mjs --auth=auth-token
node --test scripts/agent-presentation/claude-mods-probe.test.mjs
~~~

Both native scenarios use managed Claude Code 2.1.296, a new temporary home,
fake credentials, an empty fixture workdir and a loopback Anthropic provider.
The first sets ANTHROPIC_API_KEY, the second ANTHROPIC_AUTH_TOKEN without an
API key. No Anthropic login or cloud Remote Control is involved. Each uses one
PTY process and one native session throughout five main turns. Native plugin
validation and the CLI's plugin test run before interactive execution.

The final scenarios each pass 14 focused checks:

- A real hooks module loads; its structured events retain the native session.
- GUI-origin semantic input starts a native turn. turn.step text reaches the
  bridge while the provider response is still open and appears in the TUI.
- A second GUI input submitted mid-generation runs after the first completes.
  Streaming continues while its submission promise remains pending.
- A partially typed native draft survives GUI submission and completion. Enter
  then submits that same draft through the original TUI; native prompt/turn
  events and completion confirm it, rather than a terminal-text guess.
- turn.abort with the current native turn ID closes an intentionally unfinished
  response. The native aborted event and command result arrive; the stale ID is
  rejected afterwards. The same process accepts and completes a further input.
- Each fixture main turn makes one provider request. Title requests are separate:
  under bearer auth the title also uses Sonnet, so model equality is insufficient.
- No dropped bridge event or unexpected bridge/command error is observed.

Important implementation findings:

- on() event names must be string literals. Passing the engine object to a
  locally nested helper is rejected by the native module compiler; host calls
  stay at explicit call sites. Native validation catches these constraints.
- The tested native plugin harness did not provide the documented stream.result
  value in the initial experiment. Consuming the generator's final return value
  preserves the real result. The mirror calls next(e) once, yields every chunk
  unchanged (including opaque engine refs), and closes its downstream iterator
  on early exit. Native and Node tests cover the pass-through behavior.
- A plugin submission is explicitly plugin-origin. Claude adds a visible/model
  message envelope identifying the plugin. This is not indistinguishable from
  a composer user message; the adapter must retain that provenance internally.
  The GUI hides only Lex's own bridge label/envelope as specified above; it does
  not hide sources from other plugins or rewrite the native transcript.
- A busy prompt.submit promise settles only after the preceding turn completes
  in these runs. Command dispatch, native acknowledgment and turn completion are
  separate facts. Awaiting that promise in the event pump caused delayed event
  delivery in an intermediate probe; commands now run independently of the pump.
- The Mod has no Node server. Host HTTP plus an authenticated loopback exchange
  carries events and commands. Its bounded observation buffer never blocks the
  native stream; overflow/failed delivery is reported, not claimed as complete.
  This disposable probe is not a durable/reconnect-safe production protocol.
- /plugin-types returned Unknown command in the tested interactive configuration;
  no runtime declarations were exported. Do not infer general unavailability
  from that result or claim repository types were exported from this binary.

Final raw reports are ci-logs/claude-mods-native-api-final2.json and
ci-logs/claude-mods-native-token-final.json outside the repository. Earlier
compiler/harness/assertion failures remain separately recorded. All probe-owned
native processes exited and their temporary profiles were removed.

This closes the earlier basic streaming/semantic-input feasibility gap for the
tested Windows/BYOK configurations. It does not finish the four product adapters
or permit RC publication. Permission races, durable host message association,
attachment bytes, compaction, other mods, backpressure
recovery, actual subscription accounts, SSH, Device Link and non-Windows hosts
still require their own acceptance. No production UI or user install changed.

### Native message identity and GUI source display

The follow-up `--scenario=identity` passes 18 checks on the same managed 2.1.296
binary, including the earlier continuous controls. Its `session.append` hook
observes user and assistant UUIDs; every observed user/assistant row matches
the isolated JSONL transcript by UUID, role and content after native shutdown.
Native JSONL stores plain user text as a string whereas the hook exposes a text
block array; the comparison normalizes only that representation. Version 296's
repository declarations omitted this hook, but the actual binary supports it.

Serialized bridge submissions associate four command IDs with four native user
UUIDs; the TUI-origin row remains unbound. Identical input is not deduplicated by
text. The display projection in
`packages/maker-core/src/agents/claude-code/native-message-projection.ts` restores
the host's original input only for a matching session/UUID and trusted built-in
submission. Six focused cases retain external plugin labels, unmatched rows,
attachments and literal plugin-looking input, and preserve the raw native row.
The real probe exercises the same projection. Persisting these associations and
wiring them to product history/GUI remains adapter work; this helper alone does
not enable the product UI. Evidence: `ci-logs/claude-mods-identity3.json`.

### Native permission observations

`--scenario=permission-gui`, `permission-tui` and `permission-deny-rule` each
pass nine focused checks with a synthetic Write confined to the owned fixture.
GUI semantic denial prevents the write; answering the original terminal dialog
allows exactly the expected file; an explicit native deny rule removes Write
before `tool.call`/`tool.check` and returns an error tool_result with its native
tool_use_id. The absence of those hook events in the last case is not a bypass.
The fake provider now recognizes tool-result continuations as the same main
turn instead of misclassifying them as title requests. Native policy/results
are forwarded unchanged. Evidence: `ci-logs/claude-mods-permission-{gui,tui,rule}2.json`.

These are separate single-answer cases, not permission-race acceptance. The
native dialog can remain visible while the module awaits an answer; a terminal
answer did not abort the pending PermissionRequest hook in the observed run.
The classic hook also lacks tool_use_id. Reliable retirement, parallel-call
identity and late/duplicate GUI answers still require a production solution.
No global allow override or modified permission policy was introduced.

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
All-four-engine exposure and RC gates remain closed pending full adapter and
remote acceptance; the subsequent Claude Mods probe is a basic feasibility
result, not permission to skip those gates.

## Upstream reference

VelaTerm reference: `vlinx-io/VelaTerm` at
`afb143c7080c2aad88be36ae8f255e74a58f9ddf`. Its engine switch, process ownership,
PTY exit fencing and native-session recording are useful references. Its
stop/resume handoff is not the normal Lex presentation-switch mechanism. Its
recorded-conversation mobile UI does not by itself prove reliable structured
control, input acceptance or approval synchronization.
