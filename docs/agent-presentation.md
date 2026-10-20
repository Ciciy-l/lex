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

### Task ownership and packaged semantic transport

`AgentPresentationRuntime` now gives a live task its own terminal generation,
bounded output replay and attachment-specific input lease. Detaching all views
leaves the native driver alive; takeover fences the old writer. An uncertain
write cannot be replayed with the same sequence. A missing output prefix is
reported as a gap, not rendered as a complete terminal screen. The task-owned
headless terminal now supplies bounded screen snapshots, including alternate
buffer, cursor and pending escape state, and answers device queries without a
renderer. MainIPC/Device Link attach only to that existing runtime. The desktop
footer and terminal view preserve the mounted GUI and release input control
when hidden; reconnect never replays uncertain input. Production adapters must
still supply their live presentation before the control becomes available.

The packaged Claude Mod and authenticated host side channel are in
`native-mod-source.ts` and `native-bridge.ts`. Commands retain one ID across
transport retries; events are acknowledged in order. Native callbacks are
session/generation-bound, separately identified, and retired even when the
retirement arrives before its HTTP request. Changed payloads cannot reuse an
answered identity. Neither a credential nor a host execution path is sent to a
renderer. These components are not yet selected by the production agent.

Run `node --import tsx scripts/agent-presentation/claude-bridge-probe.mjs` for the actual
packaged source and host transport, with the same isolated native/provider
assertions as the earlier fixture. `--scenario=permission-gui` and
`--scenario=permission-tui` cover single-answer decisions. Managed Windows Claude
2.1.296 passed the 18 identity/control checks and nine checks in each permission
scenario. The native compiler and plugin test also passed; each probe exited
and removed its owned temporary profile. Pure tests cover lost receipts,
retirement ordering, replay fencing, queue bounds and stream pass-through.

This does not close the remaining adapter gates. In separate actual-native
attachment probes, both image-path text and `PromptSubmitAttachment` metadata
through `$.prompt.submit` completed without image bytes reaching the provider.
Reading the image inside the Mod did not insert it into the model conversation.
The native composer did send the same fixture image. Do not silently substitute
a text-only GUI submission for an attachment, or claim this transport alone
preserves all SDK policies, subscription refresh, parallel approvals or SSH.

The subsequent packaged `--scenario=media` route expands host-staged images
through the owned native slash command and correlates its command/meta rows by
submission identity. It substitutes the original prompt only in that owned meta
row after attachment expansion. The actual host PTY probe
`node --import tsx scripts/agent-presentation/claude-terminal-probe.mjs` passed
20 checks, including image bytes reaching the fake provider, literal prompt
preservation and screen recovery. Evidence: external
`ci-logs/claude-permission-lifecycle/production-terminal2.json`. This fixes that
specific media transport gap; it is not product attachment acceptance.

`native-runtime.ts` now owns the plugin, authenticated side channel and original
PTY as one lifetime. It exposes presentation during startup, requires a native
ready identity, and confirms process exit before removing the temporary plugin.
`native-hooks.ts` reuses the existing PreToolUse/PostToolUse/failure/denial/exit
callbacks instead of replacing their image, command or subagent policies. Native
and host refusals are retained and cancellation retires outstanding callbacks.
Configured host hooks must be acknowledged in the ready handshake. The actual
`--scenario=permission-host-hook` passed 10 checks on managed Claude 2.1.296,
including native tool/session identity and a denied fixture write, with confirmed
exit and profile cleanup. Evidence: external
`ci-logs/claude-permission-lifecycle/production-host-hooks4.json`. Full adapter
selection, native-input admission/history, subscription refresh, live settings
and parallel GUI/TUI approval acceptance remain required integration work.

`native-messages.ts` now binds host input IDs before native dispatch, freezes the
original content, and supplies the actual accepted native row plus its display
association through the runtime's `onUserMessage` callback. Foreign plugin rows,
native composer rows and late uncertain submissions are distinguished by
identity. Metadata/tool-result rows do not create additional user messages.
`node --import tsx scripts/agent-presentation/claude-runtime-probe.mjs` exercises
this exact production runtime and host PTY, not a separately constructed bridge.
Its 22 checks passed, including four distinct input receipts, managed image
identity in the projection, native composer history, abort and one process
lifetime. Evidence: external
`ci-logs/claude-permission-lifecycle/production-runtime2.json`. The first attempt
was rejected before launch because the fixture included an initial diagnostic
command; the corrected fixture removes that command instead of relaxing runtime
identity checks.

The runtime now associates accepted native row UUIDs with `turn.start` and holds
the first root `turn.step` behind a host admission callback. The separate request
connection waits for ordered events, rather than matching prompt text. This gate
uses the documented streaming-hook boundary: `session.append` cannot refuse an
ordinary user row, and `turn.start` is observational. Missing/refused admission
aborts the same turn without invoking the underlying model step. It does not
erase the row already accepted into the native transcript. Subagent steps retain
their native lifecycle and existing host tool policies.

`Session.acceptNativeInput` reuses the normal reservation, provider preflight,
turn observer, history callback, cancellation, vision and review preparation. Its
host-only continuation accepts the held native input and never calls `handle.send`
again. A foreign session, reused capability, Stop or uncertain receipt follows
the same existing rejection/shutdown boundaries as GUI sends.

The updated runtime probe passes 24 checks with the real CLI and production
Session: five model turns traverse five distinct reservations and terminal
callbacks, including original TUI input. `--deny-admission` passes 13 checks with
zero provider requests, native aborted finality and the process still alive
before explicit cleanup. Evidence: external
`ci-logs/claude-permission-lifecycle/production-session1.json` and
`production-session-denied1.json`; both confirm native exit and profile cleanup.
The host handle, history callback and credentials are isolated fixtures: these
are not Desktop database/MainIPC/UI acceptance. Production adapter selection,
durable history/media ingestion, queued/continuation admission and live settings
remain to be connected. The callback must not acknowledge vision rewrites it has
not actually installed in the native input.

Desktop now binds native-input admission to the exact Session and database owner
in `wireSessionToIpc`. The single native resolver goes through input-coordinator
screening and the existing send transaction's policy/history callbacks. It never
rebuilds the native process or waits behind a competing send lock. Unbinding,
account replacement, Stop and uncertain receipts fence the continuation; an
unconfirmed native row is never restored as a GUI queue item. Managed image
identities and authenticated plugin provenance survive durable Desktop/mobile
history. These bindings are exercised by focused tests, not native UI acceptance.
`claudeNativeMedia.ts` now imports supplied native image bytes through the
existing media store, verifies their type, pins a task reference before returning
the managed identity, and fences account/database/runtime changes and cancellation.
Concurrent imports share the existing task media lock and compensation journal.
Imported images retain the task lifetime rather than becoming unreferenced
drafts while admission is pending. It does not
fetch native URLs or interpret SSH paths locally; document import is still
outstanding. The Session binding carries this importer with the same owner as
admission. These are host tests, not real-image Desktop/phone acceptance.

Claude's packaged Mod now prepares original TUI and external-plugin input in
the official `session.append` hook, before native content is pinned. The runtime
waits for the actual append receipt, exact UUID/content, and host completion
before admitting the provider step. Text rewrites and original-image removal
are supported; adding/replacing native media or dropping opaque blocks is
refused. Cancellation and bounded pending records fence late acceptance.

The actual managed 2.1.296 CLI probe with `--prepare-native-input` passes 25
checks through the production Core Session resolver, including host-rewritten
text reaching the loopback provider. `--deny-native-input` passes 17 checks:
the refused original TUI input causes no corresponding model request, the
native turn aborts, and the next GUI input succeeds in the same process. Both
confirm process exit and temporary-profile cleanup. Evidence: external
`ci-logs/claude-permission-lifecycle/production-preparation2.json` and
`production-preparation-denied1.json`. A subsequent audit found that the latter
probe's refused text still entered the next allowed turn's history. The Mod now
replaces refused text/media with a neutral receipt before native append and
still aborts that turn. Opaque blocks or altered refusal receipts interrupt the
bridge rather than letting the next turn inherit unverified content. The old
17-check refusal result alone does not establish this later-request guarantee.
Neither probe exercises Desktop DB/MainIPC or the production image
importer. Full engine selection, event translation, native permission races,
live settings/auth parity, document handling and real UI/remote acceptance
remain required. No production engine is enabled by these host-side changes.

`native-events.ts` now translates root native text/thinking, actual transcript
UUIDs, tool results and turn terminals into existing Maker events. The Mod only
attaches assistant rows to a step while that actual step hook is active; it does
not manufacture SDK request/message ids. Child-loop events cannot finish the
root task. Step stop/result usage is deduplicated through the existing tracker,
but Mods lacks request/retry billing identities, so the segment ledger remains
explicitly incomplete and no price is invented. Native policy-denied tools can
settle from their actual transcript results without a `tool.call` callback.
Subagent task projection, compaction/history repair and complete accounting still
need adapter integration.

The actual `production-events1.json` probe passes 27 checks through this
translation and Core Session lifecycle, with five root completion events and
real assistant receipts. `production-events-denied2.json` passes 20 checks, now
including inspection of all later main-provider request bodies: the refused
original text is absent. The next GUI request succeeds in the same process.
Both live under the external `ci-logs/claude-permission-lifecycle/` directory,
confirm native exit/profile cleanup, and use isolated fake credentials/provider.
These still use a fixture handle and do not prove the Desktop production engine
selector, full tool/approval UI, native imported image display or phone behavior.

The event translator now waits for successful host admission before projecting
running state or completion into the product Session. A refused native append
still has a native aborted turn, but that turn cannot clear or settle another
GUI reservation. A provider step before admission faults the bridge. Native
`tool.call` arguments are flattened; the fallback preserves them, including a
tool argument literally named `input`, while validating the actual tool id/name.
The follow-up actual `production-events2.json` (27 checks) and
`production-events-denied3.json` (20 checks) pass with five and three product
completions respectively, confirmed process exit and profile cleanup. The
refused turn is excluded only from product events, retained in raw evidence.

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

GUI sends now carry a host-only `onNativeUserMessage` observer alongside the
existing queue UUID. The native bridge delivers the actual accepted UUID and
authenticated source to that observer, including a late receipt after an
uncertain command response. It never serializes the observer or waits for a
database write in its semantic event pump. The Desktop send transaction captures
the exact Session, database owner and clear generation before dispatch. Its
receipt patches the original visible user row with one conditional SQLite
`json_set`, preserving concurrent metadata and broadcasting the authoritative row
over the existing Desktop/phone history channel. Clear, rewind, deletion,
replacement and conflicting receipts do not revive or relabel an old row. A
failed association is diagnostic only; it never resubmits accepted input. Pi's
transcript-entry callback remains separate. The native Maker handle now passes
this observer into `runtime.submit`; production engine selection and shared
launch/control parity remain gated, so this does not enable GUI/TUI switching.

### Native Maker handle and product input queue

`native-session.ts` now implements the Maker handle over the continuous native
runtime. GUI input enters through real `Session.send`; original TUI input enters
through that same Session's pre-append resolver. Both use the supplied Claude
policy and exact native receipt. The handle publishes its task-owned presentation,
semantic event stream and usage snapshot. Stop targets the current native turn;
view detach never closes it. Missing dispatch receipts use Session's existing
unconfirmed-dispatch shutdown, while an actual accepted row survives a lost
command response without resubmission. Native same-turn steering remains
unsupported here: Mods `prompt.submit` schedules a new turn. It must not be
advertised as the old streaming-input steer capability.

Run `node --import tsx scripts/agent-presentation/claude-session-probe.mjs` for
the actual managed 2.1.296 CLI, production handle, Core Session and Desktop PTY
driver with isolated homes and a fake loopback provider. The second run passes
26 checks, including five product reservations/terminals, four GUI UUID receipts,
one original TUI input, streaming, Stop followed by another input, retained
native draft and view detach/reattach during generation with the same process
and presentation generation. Its fixture queues GUI follow-ups until the real
product terminal, rather than submitting into Claude's busy queue. The old
direct-native queue checks are retained as separate baseline results; they are
not counted as product-queue passes. The earlier run failed those two mismatched
baseline checks; it is preserved. Evidence: external
`ci-logs/claude-permission-lifecycle/production-handle2.json`. This still does not
exercise the product engine selector, Desktop MainIPC/renderer, credentials,
full shared launch configuration, permissions or remote UI.

Live-settings experiments on the same isolated runtime establish a narrower
boundary. `config.set(model)` changes the running model but writes
`CLAUDE_CONFIG_DIR/settings.json`, even with a distinct `--settings` file and
empty setting sources. A `turn.step` model/effort rewrite changes subsequent
provider requests without a settings write or process replacement, but does not
change `session.model()` or establish native selector/UI synchronization.
`command.run(model)` did not preserve the existing draft or apply the requested
model in these experiments; its command result is not an applied-state receipt.
None is yet a complete product live-settings implementation. Original reports
remain under `ci-logs/claude-permission-lifecycle/`; no real profile was read or
changed.

### Shared local launch configuration

The existing SDK startup now builds a typed `ClaudeLocalSessionLaunch` before
transport selection. Its model, resolved provider environment, permission and
tool callbacks, allowed tools, memory/skill settings, plugin roots and assembled
system prefix retain the existing values and ordering. `claudeSdkOptions` owns
only SDK transport plumbing. This does not change the engine selector.

`prepareClaudeNativeLaunch` projects those same inputs to original interactive
CLI flags and owned temporary files. MCP URLs, headers, stdio commands,
arguments and environment values travel via per-launch environment references,
not plaintext launch files or command-line arguments. A host must project every
in-process MCP under its exact name; none is silently dropped or serialized as
an SDK instance. The projection retains HTTP, SSE and stdio forms. Unsupported
history restore and subscription-refresh paths currently reject preparation;
they must be implemented before this factory can replace normal GUI startup.
The host must dispose these files after confirmed process exit, never on detach.

Run `node --import tsx scripts/agent-presentation/claude-session-probe.mjs --prepared-launch`
for the isolated actual-CLI path through this launch factory, the native Maker
handle and Core Session. Managed Claude 2.1.296 on Windows passes 29 checks:
all five main requests contain the exact fixture prefix and have the same
system hash, with the existing queue/Stop/view-lifetime checks and confirmed
launch-file/profile cleanup. This measures prefix stability, not a real-provider
cache-hit rate. No new file IO occurs on the per-token path. Evidence: external
`ci-logs/claude-permission-lifecycle/production-shared-launch1.json`.
The separate `mcp-env1.json`, `mcp-stdio1.json` and `mcp-semantics1.json` probes
verify actual native environment expansion, including empty values, defaults
and non-recursive credential substitution. They do not establish full product
MCP tool-call or child/root provenance parity. Actual MainIPC/UI, host bridge
registration, live controls and remote acceptance still remain.

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

Those initial single-answer cases did not establish permission-race acceptance:
the terminal answer did not abort the pending PermissionRequest hook, and that
classic hook lacks tool_use_id. The packaged bridge now serializes entry into
that hook using the actual tool.check/tool.call scope per native agent. It
releases the gate as soon as the callback has its ID, allowing the actual tools
and user decisions to overlap. It preserves the native verdict, ceiling and
original classic input; unscoped queries never mint a guessed GUI identity.
Tool completion retires that exact callback before root turn completion, even
when the terminal answered and the classic hook is still waiting on HTTP.

The opt-in `claude-permission-identity-probe.mjs` passes 15 checks on the actual
managed Windows 2.1.296 binary: two Read calls with identical arguments really
overlap, each has its own native ID and GUI denial, and both native results are
preserved. `--scenario=permission-tui` passes 12 checks: the native Write dialog
accepts the terminal answer, writes only the fixture, retires its GUI callback
before the turn completes and rejects a late GUI denial. Both use fake loopback
credentials, exit the native process and remove their temporary profiles.
Evidence is `ci-logs/claude-permission-lifecycle/permission-causal-production2.json`
and `permission-tui-retirement1.json`, outside the repository. Earlier experiments
remain separately recorded; the Write-only parallel experiment did not overlap.

`native-permissions.ts` maps the authenticated callback to the existing product
canUseTool policy. That policy now consumes the request's cancellation signal
for permission, question and plan cards, dismissing only the matching request
and discarding its late result. Focused regressions also preserve sibling cards,
native allow/deny decisions, repeated checks and native deciders that complete
without a classic callback. This is not full product/MainIPC approval acceptance:
production engine selection, other plugins, live configuration and subscription
auth parity remain separate integration work. No global allow override or
replacement permission policy was introduced.

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

### OMP ordinary product adapter, 2026-10-20 (implementation; window acceptance pending)

Explicit local OMP presentation now selects the ordinary Main PTY factory after
the same managed model/provider, prompt, permission, Skill and host-tool startup
preparation as RPC. The original interactive OMP loads a task-scoped official
extension. GUI sends use `sendUserMessage`. In OMP 18.10.4, provider context is
prepared before the input events allocate a journal row. The context hook first
admits a distinct bridge submission through Core Session and installs the
host-prepared bytes. The official `before_provider_request` hook then requires
the unique matching real journal row before permitting the original request;
it does not rewrite provider payloads. Native and GUI receipts bind that real
row to the existing product message, without presenting a submission ID as a
native ID or native input as plugin input. Stop uses `ctx.abort`,
and extension `agent_end.willContinue` determines the final product boundary.
History resume requires the existing absolute session file; missing history or
an unconfirmed command never falls back to another task or automatically replays.
Launch files and leases remain until the exact native process has exited.

This connects an adapter to the ordinary product entry, not just the earlier
probe. Focused tests cover Session admission, continuation, unknown outcomes,
same-file resume, host-tool ownership and Main cleanup. The Windows isolated
ordinary Desktop at `c465054de` passed same-file history recovery, original-TUI
input and GUI result return, GUI semantic continuation, running-process dual
drafts/focus, and Stop followed by one explicit new native input without an
automatic continuation. A fresh unnamed task also completed its first input
directly from TUI and returned the same history to GUI. SQLite receipts matched
the real native journal IDs, and each explicit input produced one loopback
provider request. Evidence is retained under `rc1-omp-window4` outside the repo.
The model was simulated: real suppliers, native tool approval and other
platforms are not covered. Native journal usage was present, but persisted
product total usage remained zero and is a separate observed gap. Model/source
changes use the existing managed-route rebuild;
the native permission mode remains fixed for this process. Pi's production
interactive extension adapter is still separate work; this does not complete
all four engines or establish SSH, Device Link or non-Windows acceptance.

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

### Claude production entry and Main ownership, 2026-10-19

`ClaudeCodeAgent.startSession` now has a host-only native factory branch. It
shares the existing launch assembly, selected MCP factories, input permission
policy, capability selection, auto-review intent and interaction event queue.
The branch never creates an SDK Query. It is not injected into normal Desktop
boot yet: plan/live controls, subscription refresh, partial history restore, full usage
and remote parity remain required before product exposure.

Main's `createClaudeNativeHostSession` owns the actual PTY, process registration
and an authenticated HTTP projection of the exact task-selected MCP servers.
It reuses the existing HTTP bridge, preserves each server name and live task
context, creates fresh server instances on reconnect, and revokes authority
before waiting for process exit. Launch files and managed Skill projections
remain until confirmed exit; a view detach does not dispose them. GUI images
use the same prepared bytes and account-bound media importer as native input,
not a parallel attachment store. This path still requires product image acceptance.

The isolated actual-native probe `production-main-host4.json` passes 29 checks
through the real Agent start method, Main factory, Core Session and PTY. It
observes five turns, GUI streaming/queueing, original TUI input, preserved draft,
Stop followed by another input, one process across detach/attach, and confirmed
exit/temporary-profile cleanup. Five request system hashes are identical. The
provider and task/history bindings are fixtures; built-in tools are disabled
in this probe. It is not DB/MainIPC/UI, production tool policy, cache-hit-rate,
phone or SSH acceptance. Separate real HTTP MCP tests cover exact names,
context, reconnect and cross-task token/route refusal.

The first host probe failed before launch because its copied fixture used a
relative resource path. The next two reached a native bypass-warning dialog:
the SDK's allow-future-bypass flag caused an interactive warning even in Ask.
Native launch now emits that flag only when bypass is actually selected. No
warning was automatically accepted. All raw failures remain in the external
`ci-logs/claude-permission-lifecycle/` directory; the fourth probe succeeded.

### Claude interactive startup

The native handle publishes its terminal as soon as the PTY exists, before a
trust/onboarding dialog finishes. Only the actual ready handshake publishes the
durable session ID. Human onboarding has no default process deadline; opt-in
unattended probes may still request a bounded startup deadline. GUI input waits
for readiness with its own deadline and cancellation. Stop, close and cancelled
input never replay that input after the native process becomes ready.

The isolated real-Agent/Main/Session probe `production-startup2.json` passes
31 checks on managed Windows Claude 2.1.296: the handle returns at 1.5 seconds,
the native trust dialog is answered at 35 seconds, and five subsequent turns
preserve streaming, queueing, terminal draft, Stop and process identity. Exit and
temporary-profile cleanup are confirmed. It uses a fake provider and fixture
history bindings; this is not MainIPC/database/UI, phone or SSH acceptance.
The focused startup tests also exercise a real Core Session reservation cancelled
before readiness, with no native submit and no process restart.

### Claude native context usage

The existing `Session.getContextUsage` path now reads the interactive process's
official `session.usage({ breakdown: 'full' })` result. Concurrent readers share
one count request and receive independent snapshots. It does not submit a
message, run `/context`, touch the native draft or maintain a separate ledger.
Missing/malformed required values fail explicitly; native categories and extra
metadata remain intact. Reads have a 30-second deadline and are cancelled when
their task closes or its native process exits; late replies cannot publish into
a replacement owner.

Managed Windows Claude 2.1.296 returned a full context breakdown through the real
Agent/Main/Core Session in `production-context1.json`. The offline audit has 33
passing checks, including one native read for two concurrent GUI consumers, no
extra product turn, stable request system prefixes and owned-profile cleanup.
The first report expected an unsuffixed model name; the corrected audit compares
the actual resolved launch model, including `[1m]`, without changing the raw. A
separate raw-context probe likewise required an audit correction for its fixture's
`ack` event alias. These are isolated fake-provider observations, not product
UI, real token-cost accuracy, subscription, phone or SSH acceptance.

### Claude explicit history reopen and approval ownership

Explicitly reopening a closed task now selects native `--resume` with its existing
session ID. Fresh starts alone use `--session-id`. View attach/detach still does not
close or reopen anything. Resume identity cannot be overridden through generic
CLI arguments; partial rewind/fork remains gated. Existing transcript relocation
and preflight are reused, but a missing native transcript must not clear the
saved ID and silently create a fresh conversation.

The isolated real-Agent/Main/Core Session probe `production-resume2.json` and its
40-check audit confirm the same native ID, an explicit close before a new PID,
old and new messages in the resumed provider request, finality, confirmed close
and owned-profile removal. The first fixture incorrectly waited for observers
that explicit driver close had already detached; its failure is retained and
its unknown residual profile is not claimed as cleaned. The corrected run still
logged two node-pty `AttachConsole failed` helper errors during explicit close;
both task close promises resolved and both native PIDs were absent afterward.
This is Windows/fake-provider evidence, not MainIPC/database/UI, phone or SSH
acceptance, nor proof that the helper-close race is fixed.

Separate real-Agent/Main/Core Session permission probes preserve the production
policy with the actual native Write tool: GUI denial reaches the provider as a
denied result without creating the file; original TUI approval creates the file
and retires the GUI card. A late GUI denial neither changes that result nor runs
the tool again. The final GUI/TUI probes pass 17/19 checks and clean their owned
profiles. They do not establish remote or product UI acceptance.

### Claude native counters and compaction projection

The native factory now shares the owning Agent's usage tracker, including its
resolved model context window before the first reply. At each root completion,
the Mod reads the native status-line counters with plain `session.usage()` and
projects cumulative cost once; it does not invoke the full token-count API. A
native window fills only a missing host window. Missing or malformed cost is not
reported as zero. Mods lacks provider retry/fork request identities, so native
usage segments remain explicitly incomplete for billing purposes.

Committed root compactions from the original TUI/automatic path and the direct
semantic `session.compact` command publish the same GUI boundary and available
token counts. Child/precompute/veto/error results do not change GUI context. A
measured zero is distinct from an absent count; the terminal turn aggregate must
not overwrite the most recent compaction until a new native API usage arrives.
Boundary IDs identify this bridge lifetime and sequence, not native transcript
UUIDs. Summary contents are not copied into the boundary event.

The isolated actual-Agent/Main/Core Session usage probe `production-usage2.json`
passes 35 checks, including the selected 64K context window, cumulative cost
without double addition, five turns, one native process, draft/Stop behavior and
owned-profile cleanup. The first fixture supplied no model-limit resolver and
incorrectly expected a known window before the first native reply; its 34/35
report remains available. These are fake-provider counters, not billing accuracy
or actual MainIPC/database/UI acceptance.

Both `production-compaction1.json` (direct semantic command) and
`production-tui-compaction1.json` (original TUI `/compact`) have 43-check offline
audits confirming the native boundary, post-compaction GUI counts, five product
turns, continued sending and confirmed process/profile cleanup. Their inherited
probe baselines exited nonzero because compaction adds a summarization request
and changes the native system prefix; the audits explicitly classify all six
requests and keep those raw failures. Prefixes are stable within each side of
the compaction, not across it; no cache-hit-rate claim follows. The TUI fixture
deliberately edits the terminal draft to enter `/compact` and restores it with
fixture keyboard input, so that action does not prove draft preservation.

The separate generic `command.run({ command: 'compact' })` experiment exposes an
unresolved input-admission mismatch: its command is appended through the prompt
door before a turn starts, leaving a reservation that rejects the next input.
Do not use that generic route for product compaction; direct semantic compact
and the original TUI route avoid it. Product control wiring, subscriptions,
MainIPC/database/UI, phone, SSH and non-Windows acceptance remain open.


## Codex shared native service and input admission

The local task host accepts an injected native app-server service; ordinary boot
does not inject it yet. Control-plane probes and SSH retain their existing
transports. The service uses an OS-allocated loopback WebSocket listener and an
in-memory capability; argv contains only its verifier. Main owns the socket and
process, while individual frontend connections own neither other frontends nor
the service. Disconnect does not replay input. Shutdown confirms native process
exit before reporting success. The native diagnostic listener line discovers the
port only; conversation state still comes from structured protocol messages.

The official app-server documentation confirms the original `codex --remote`
frontend, but describes WebSocket transport as experimental and unsupported for
production. This remains an integration risk to evaluate against the managed
binary, not a guarantee inferred from the API documentation.

The Codex handle's host-only native admission reuses `Session.acceptNativeInput`
and the existing send policy, usage lifecycle and turn reconciliation. It holds
the original TUI request, keeps `clientUserMessageId`, and forwards the prepared
input once on the original connection instead of issuing another `turn/start`.
Unchanged native text metadata, Skills and mentions survive preparation; image
history requires a host importer. Unknown replacement media is refused. Closed
or changed owners and cancellation fence acceptance; a lost forwarded receipt
is uncertain and cannot enter the stale-thread replay path. Presentation-owned
gateway registration, native model/permission changes, steering and approval
ownership still require production integration.

Managed Windows Codex 0.162.1 passed the isolated native service probe
`production-codex-service1.json` (seven checks) and actual CodexAgent probe
`production-codex-agent2.json` (eight checks). The first Agent fixture failed
because its disabled memory MCP entry lacked a transport; the corrected fixture
adds a disabled loopback URL without weakening product checks. Both processes
and temporary profiles were confirmed cleaned.

The actual Agent plus Core Session probe `production-codex-admission2.json`
passes ten checks: three GUI/TUI/GUI inputs traverse three product reservations
and terminals, the original native message ID reaches the history callback,
both views observe streaming, and a GUI turn completes after TUI disconnect.
Only the protocol interceptor and history callback are fixtures; they are not
Desktop database/MainIPC/UI or remote acceptance. The native title-only auxiliary
thread is recorded separately and not counted as a task turn. The raw retains
the temporary-home PATH-alias warning and the deliberate `fullAdapterProven:false`.
No actual provider credentials, live account or user profile were used.


### Codex native approval ownership

The native frontend shares command/file approvals with the existing Agent policy.
The host's shell policy, Auto reviewer and forced single-call confirmation run
before an approval becomes visible to a native frontend. One existing host RPC
callback owns the answer; the first GUI or TUI response retires all other views.
Numeric server request IDs are tracked separately from product approval/item IDs,
including server cancellation while review is in progress. Native rule amendments
must exactly match a server-advertised option. Network deny amendments stay denials;
forced confirmation cannot create a session or persistent grant.

Main's existing interaction dismissal path records the actual native allow/deny
and any explicit session grant instead of replacing it with a default refusal.
Persistent native rules remain owned by Codex, not copied into Lex's permissions.
The added dismissal metadata uses existing events and is ignored by old consumers.

The isolated native approval probe records GUI/TUI/GUI turns on one process and
thread, three host responses, only the TUI-approved command executing, and a late
GUI denial having no effect. It uses a fake provider and a fixture gateway;
production PTY/gateway registration and MainIPC/UI/remote acceptance remain open.
MCP elicitation, extended permissions and native questions still require their
corresponding shared-response integration before exposing the full adapter.

### Codex task-owned original frontend

The protocol relay and Main factory now launch the upstream remote TUI against
the existing task service. A separate task capability, private frontend home
and OS-only environment keep service/provider credentials out of the frontend
launch. Browser origins and foreign listener routes are refused. Request ids
remain correlated to the native UI; unique upstream ids prevent a late receipt
from satisfying a later request that reused an id. Pending calls, frames and
pre-initialization approval snapshots are bounded.

Only policy-approved prompts enter the TUI. Its answers return through the
existing Agent callback; raw server requests never gain a competing responder.
Detach preserves the PTY. Task close revokes access before closing the frontend,
and removes its temporary home only after confirmed exit. A natural frontend
exit retires access while leaving its last screen readable.

The isolated Windows `codex-host-presentation-native2.json` probe passed 18
checks with managed Codex 0.162.1: real Agent/Core Session, original PTY, three
GUI/TUI/GUI turns, one thread/service, one native-approved tool, ignored late GUI
denial, detach/reattach and confirmed cleanup. Its predecessor's fixture wrote
after terminal exit; that failed report and unconfirmed residual home are kept.
The successful probe still injects fixture request/notification policy. Normal
boot selection, task-bound model/permission controls, remaining native questions,
MainIPC/database/UI, phone, SSH and non-Windows acceptance are not established.
The same 18 checks also pass against the actual repository implementation in
`codex-root-presentation-native1.json`, including the unique upstream request
ids and confirmed service/frontend cleanup. This repeats the transport proof,
not the still-open product acceptance.

### Codex task and concrete process ownership

The Agent now owns its optional native presentation and publishes it on the
actual session handle. The host captures the already-running concrete service;
reading that binding never starts a replacement. Task close, native service
exit and host retirement revoke the frontend before asynchronous cleanup. A
late frontend factory result is still closed, and an obsolete service endpoint
cannot attach to a newer process. Frontend cleanup never owns the shared service.

The isolated Windows probe `codex-agent-presentation-native1.json` passes 19
checks with the real Agent-owned presentation, Core Session, Main factory and
original Codex PTY: three GUI/TUI/GUI turns, one service/thread, shared approval,
detach/reattach, and confirmed process/profile cleanup. Request routing and
history bindings are still fixtures. This is not ordinary boot selection,
MainIPC/database/product UI, phone or SSH acceptance; production task-bound
controls and remaining native interactions are still required.

### Codex native MCP confirmation

MCP tool confirmations now use the same policy-gated, single-answer broker as
command/file approvals. Native choices only become available after the existing
host policy and Auto review. GUI resolution, cancellation and native resolution
retire the other view; native acceptance preserves the actual permission history.
Session persistence must be advertised by the server and permitted by host policy.
Arbitrary forms, URLs and metadata are not accepted as tool confirmations.

Task configuration only registers its selected permission profile and keeps its
selector in that same per-thread snapshot. This fixes native MCP/settings reload
without writing a global default or granting additional filesystem access.

The isolated real Codex 0.162.1 probe `codex-mcp-native8.json` verifies native form
acceptance, GUI dismissal, exactly one allowed fixture tool call, three GUI/TUI/GUI
turns and process/profile cleanup. The earlier probe did render the native form
but sent unsupported `y`; it is retained as failed evidence. Configuration probes
also verify MCP status with/without reference directories and after revocation.
Routing/history remain fixture bindings: ordinary boot, product UI and remote
acceptance are still open. This evidence does not establish full adapter parity.

### Codex native questions and GUI history

Native questions and host dynamic-tool questions now share one existing GUI
decision. The upstream TUI renders the form; its answer resolves the original
host request once. Protocol aliases reuse the same prompt, and cancellation,
host replacement and late GUI answers cannot submit a second response. Native
tool completion can retire its prompt while retaining an existing GUI follow-up.

Main validates native question ownership and records the actual answer. The
existing resolved-card push updates other GUI windows immediately, and the same
goal-clarification observer receives GUI and native answers. Unknown question
keys and unrelated engine metadata are not converted into accepted answers.

The isolated managed Codex 0.162.1 probe `codex-question-native1.json` proves
one native form answer reaches both the provider tool result and the host event,
three GUI/TUI/GUI turns share one service/thread, and owned processes/profiles
are cleaned. Main persistence/push behavior has focused integration coverage;
this does not establish actual database, product UI, phone or SSH acceptance.

### Codex extended permissions and single-operation file changes

Extended filesystem/network grants now share the existing host policy and one
GUI/TUI answer. Native grants preserve the exact reviewed permissions, turn or
session scope, and strict automatic review. Cancellation fences the native RPC
identity before review completes. The original permissions/file overlays always
offer session persistence; when host policy requires one-operation confirmation,
the upstream native question form instead displays only eligible choices. Host
copy is localized in all five languages. File-change details come from the same
item/started context already used by GUI approval when the RPC omits its patch.

Managed Windows Codex 0.162.1 passed isolated network, filesystem, forced-turn
and forced-file proofs. The file proof records only the native-approved file
being written, exact content, three GUI/TUI/GUI turns and confirmed cleanup. Its
first run exhausted a 15-second observation after native approval; the second
uses a bounded 60-second observation and preserves that failed report. Product
timeouts were not changed. These proofs still use fixture routing/history and
do not establish product UI, database, phone, SSH or non-Windows acceptance.

### Native runtime choices through the product Session

Codex model, reasoning, service tier and plan menu requests now enter an owned
Session callback. They cannot change provider routes or permissions through this
path. Native replies require a completed settings write; cancellation, task
retirement and queued writes to a replaced thread cannot report success. Failed
setters restore their own state without overwriting a newer selection. Existing
GUI setters keep their desired-state fallback.

The managed Windows Codex 0.162.1 proof `codex-runtime-native2.json` uses the
original `/model` menu with its session-only choice. The actual Core Session
receives the selection, and later GUI and TUI turns use that model on the same
thread/service. All 29 positive checks pass and temporary processes/homes close.
The first report counted a pending title request at deliberate frontend shutdown
as a routing error; the second records both its aborted signal and closing owner.
This is expected cancellation, not a successful title request. Main catalog and
settings persistence are still fixture bindings, not product GUI acceptance.

Claude's semantic bridge also avoids OS-assigned ports blocked by Fetch. It
closes an unusable loopback listener before requesting another ephemeral port,
with bounded attempts and unchanged authentication. Deterministic tests cover
blocked allocations, failure and cleanup; this fixes the observed local
`bad port` failure without changing machine networking or client protections.

### Main settings binding and task-scoped native routing

Main now binds native runtime requests to its existing model/profile transaction
and shared Plan handler. It captures the task/account/database owner, retains the
current provider and unchanged axes, and refuses a contended input lock instead
of waiting in a cycle. Native responses cannot acknowledge a deferred selection,
unresolved context-window confirmation or a required runtime replacement. Model
and Plan operations remain sequential; this is not a cross-axis atomic commit.

The Codex frontend router uses the Agent's actual descendant ownership and a
bounded MCP capability snapshot. History/notifications stay with that task;
native configuration exposes presentation metadata without credentials, origins
or transport settings. Auxiliary title requests retain their original read-only
context, with disabled MCP names completed by the authoritative task owner. The
current native structured approval flags are preserved explicitly. Catalog and
other controls still require Main's resolved provider bindings before ordinary
startup can select this adapter.

Managed Codex 0.162.1 `codex-catalog-native3.json` passes 31 positive checks with
one service/thread, native menu selection, GUI/TUI/GUI turns, approval history,
screen reattachment and confirmed cleanup. The second report sampled the screen
before its asynchronous PTY rendering caught up with protocol completion; the
third independently waits for the original screen. Its earlier failed report is
retained. This uses an isolated provider catalog and runtime callback, not actual
product database/UI, SSH or phone acceptance.

### Native images and the Desktop model catalog

Claude and Codex original composers now share Main's existing image store and
task-reference lifecycle. Codex data URLs enter as verified supplied bytes;
there is no remote URL or local-path fallback. The account, database and native
task are captured before ingestion. Real temporary SQLite/store tests cover
byte identity, concurrent deduplication, separate task references and rollback
after an account change during a committed reference write. These tests do not
establish product-window or phone attachment acceptance.

The Codex Main factory now defaults to Desktop's provider service and normal
visibility rules. Model membership and known route abilities come from the
exact task provider; bounded native metadata paging preserves the original
frontend's display and multi-agent metadata. An Agent snapshot keeps catalog
identity separate from the server's normalized model alias. An unresolved
implicit provider is refused rather than inferred from a coincident model name;
implicit-route resolution remains required before ordinary startup enablement.

Managed Codex 0.162.1 `codex-main-catalog-native1.json` passes 31 positive checks
using the real Main projection and Agent snapshot, with isolated provider-service
and account fixtures: original model menu, three GUI/TUI/GUI turns, one native
thread/service, approvals and confirmed cleanup. Windows node-pty's shutdown
helper reported `AttachConsole failed` despite the owned processes exiting; that
stderr is retained. This is not production account/database/UI acceptance.
The earlier fixed-reasoning observation `codex-no-reasoning-native1.json` records
the upstream's two settings requests followed by a default-config write. That
implementation rejected both the `effort: "none"` request and default write; its
report only proves the request sequence, not successful model selection.

### Fixed reasoning and native Stop through the product Session

Native fixed-reasoning choices now clear the reasoning axis in place. The same
Session and native thread persist; later turns retain the actual native `none`
value while GUI projects no adjustable effort. Failed settings writes restore
the previous value, and an inherited cancellation scope remains authoritative.
Existing adapters without in-place clearing retain their established behavior.

Original Codex Escape requests now bind to the exact task and native turn, then
enter the same explicit Stop handler used by GUI. Goal pausing, automatic-recovery
revocation, Agent Island status and pending interactions keep their existing
product lifecycle. Stop does not queue behind the send it must interrupt. A
native request requires a confirmed interrupt; stale requests cannot stop a new
turn, and late cleanup cannot clear another account, Session or turn's cards.

Managed Windows Codex 0.162.1 `codex-native-stop-native2.json` verifies original
model selection, GUI/TUI input, native Escape, then GUI continuation on one
service/thread, with four product turns and confirmed process/profile cleanup.
The first probe had a missing routing-scope variable in its fixture callback;
its failure is retained. The successful probe uses actual Agent, Core Session,
Main catalog and Stop binding, with fixture account/catalog and persistence
callbacks. Native default writes were forwarded only to its isolated temporary
home. This does not implement product default synchronization or establish real
database/window, phone, SSH or non-Windows acceptance. The node-pty shutdown
helper's `AttachConsole failed` stderr is retained despite confirmed owned-process
exit. Native default persistence and the remaining parity requirements still
prevent ordinary startup from selecting this adapter.

### Original Codex same-turn input

Original TUI `turn/steer` requests now carry their actual message ID and expected
native turn through the same product coordinator, input screening, review-intent
restoration and Core Session vision preparation as GUI steering. Main forwards
one owned continuation; it does not enqueue a second prompt. Native imported
images preserve their managed history identity and original wire metadata.
Cancellation, task replacement and a new native turn fence dispatch. Uncertain
receipts retain the ordinary paused-queue behavior rather than automatic replay.
Confirmed native acceptance remains irreversible if later persistence fails,
for both new turns and same-turn steering. A new-turn response must contain an
actual turn identity before it can be treated as confirmed acceptance.

Focused tests exercise the actual Main steering body, coordinator and Core
Session, including both dispatch branches' authority and wire-only mobile note.
Native probes are separate from that product coverage. The early-stop probe
previously expected four turns after Escape with an unconsumed steer. Fixed
upstream source at Codex rust-v0.162.1 confirms that Escape explicitly interrupts
to submit pending steers as a new turn; GUI Stop and Ctrl+C instead restore them
to the native draft. The failed expectation is retained, not treated as a product
replay defect or a reason to suppress native behavior.

The isolated native proofs codex-native-stop-gui1.json,
codex-native-stop-ctrlc1.json and codex-native-stop-escape2.json each pass 37
positive checks with the actual product Stop body and Core Session. GUI Stop and
Ctrl+C restore the draft without another turn; Escape submits a new native UUID.
All retain one thread/service and confirm process/profile cleanup. Escape's
first fixture omitted the steer text from its fake-provider classifier; its
failure is retained. These proofs still substitute peripheral Main dependencies:
coordinator/database handling of accepted-but-unconsumed input, actual windows,
phone, SSH and non-Windows acceptance remain to be verified.

Managed Codex 0.162.1 `codex-native-steer-consumed2.json` confirms five inputs
across four turns on the same service/thread: GUI, native TUI, GUI plus native
steer, native Stop after consumption, then GUI continuation. Shared approval,
original file action, live events, detach and process/profile cleanup pass. The
first consumed-input fixture accidentally waited for the third approval before
answering the second; it is retained, and only the fixture trigger was corrected.
This proof uses the actual Agent/Core Session with fixture Main persistence and
does not establish product window, phone or SSH acceptance.

### Pi and OMP queued input identity

Isolated Pi 1.2.0 and OMP 18.10.4 original PTYs confirmed that async-local
context alone cannot identify queued messages: the queued user row inherits the
prior running input's context. Pi exposes the second input event with its own
context, whereas the observed OMP extension send does not expose that equivalent
input event. `pi-native-identity2.json` and `omp-native-identity1.json` retain
these event sequences and confirmed native-process cleanup. No text-based
deduplication or guessed identity was added to either product adapter.

Temporary object-identity experiments identify queued GUI input correctly at
native message_start in both engines, without claiming native TUI input as GUI.
OMP creates a different message object by message_end, so a WeakMap alone is
insufficient for complete lifecycle correlation. These experiments wrap upstream
Agent methods only inside isolated probes; no prototype wrapping has been added
to the product. Extension coexistence, reload, transformed/blocked inputs and
queue cancellation still need a supported, task-owned correlation design.

### Accepted native input versus actual consumption

The actual coordinator/native binding probes exposed a history gap: a successful
Codex steer receipt can precede consumption, and Stop can return that input to the
native editor without a user item in the original turn. Escape can then submit a
new UUID. Identical text is not evidence that the first input was consumed.

Codex now tracks dispatched native steer UUIDs against root userMessage item
events and the continuous terminal stream. History separately records pending,
consumed, unconsumed or unknown. An observed item wins even if the RPC response
is subsequently lost; disconnect, runtime replacement and close never infer
unconsumed input from missing events. Early item/terminal notifications survive
late receipts and history creation. No input is automatically replayed.

Main persists the observation through the existing input coordinator and patches
the exact visible user row atomically. Account/database/runtime, clear, rewind,
native session/turn and message identity fence late updates. Renderer and remote
metadata writes cannot mint or erase this evidence. Pending input retains its
authored text in an unverified receipt; only confirmed consumption unwraps that
receipt through the existing authority invalidation path. No schema or historical
migration changes are required. Both presentation clients show a short status;
idle stale pending rows are shown as unknown. Unconsumed/unknown rows cannot be
used as native fork/rewind boundaries, including direct Main calls. Legacy and
consumed rows retain the existing behavior.

Managed Windows Codex 0.162.1 codex-consumption-gui1.json and
codex-consumption-escape1.json each pass 42 positive checks with the actual Core
Session, product input coordinator and native binding. The first input remains
unconsumed after Stop; Escape's new UUID is admitted separately. Same-thread
input, settings, live events, approval, view detachment and process/profile
cleanup remain verified. These probes use in-memory persistence callbacks and a
loopback provider, not actual product windows or a physical phone. SQLite
ownership/authority and desktop/mobile history projection have separate focused
regressions. Full adapter selection, GUI-originated steering consumption, actual
window/multi-device/SSH acceptance and the other engine gates remain unfinished.

The separate codex-consumed-coordinator1.json probe passes 37 positive checks
with the same coordinator/native binding: five inputs across four native turns,
and the consumed item's client UUID, item ID and turn match the persisted steer
receipt. It retains the same fixture persistence and loopback-provider limits;
SQL authority unwrapping is covered separately by the database regressions.

## Upstream reference

VelaTerm reference: `vlinx-io/VelaTerm` at
`afb143c7080c2aad88be36ae8f255e74a58f9ddf`. Its engine switch, process ownership,
PTY exit fencing and native-session recording are useful references. Its
stop/resume handoff is not the normal Lex presentation-switch mechanism. Its
recorded-conversation mobile UI does not by itself prove reliable structured
control, input acceptance or approval synchronization.
