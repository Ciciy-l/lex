# S4D SharedTask Desktop source appendix

This appendix records the upstream source metadata for the S4D Desktop management/invitation adaptation. Only the hunks listed in the S4D diff were adapted; no server, Mobile, attachment verifier, native, or unrelated feature tree was imported. The original commit messages below are preserved verbatim (`%B`).

## base shared-task implementation

```text
commit bca321223d8b88aef67b73c5e072a244737790f2
Author: DavidShen <david@xd.com>
AuthorDate: 2026-09-20T19:58:03+08:00
Committer: DavidShen <david@xd.com>
CommitDate: 2026-09-21T02:31:46+08:00

feat(sharing): share tasks across accounts with unified desktop and mobile flows

Signed-off-by: DavidShen <david@xd.com>
```

## #4998 server quota decision

```text
commit 36d5ef0b463059dcf2695b4f86e8f9201b1e80e9
Author: DavidShenXD <david@xd.com>
AuthorDate: 2026-09-24T14:25:06+08:00
Committer: GitHub <noreply@github.com>
CommitDate: 2026-09-24T14:25:06+08:00

fix(shared-task): 共享名额提示改为服务端判定 (#4998)

* fix(shared-task): remove hardcoded client task quotas

Signed-off-by: david <david@xd.com>

* fix(shared-task): clarify quota recovery guidance

Signed-off-by: david <david@xd.com>

---------

Signed-off-by: david <david@xd.com>
```

## #5040 Desktop management subset

```text
commit 35493f9a919f350098be43c15e5a92ec1ce0bd0b
Author: DavidShenXD <david@xd.com>
AuthorDate: 2026-09-24T23:02:39+08:00
Committer: GitHub <noreply@github.com>
CommitDate: 2026-09-24T23:02:39+08:00

fix(desktop): 统一共享任务管理面板与房主访客菜单 (#5040)

* WIP: clarify shared task invitation code input

Update desktop join copy in five locales and register the invitation code term. Typecheck and i18n checks pass. Test gate is blocked by missing MSVC link.exe; direct related tests report two database fixture errors and one plugin OAuth failure. Light and Dark visual checks were not performed. Local preservation only; do not push before gates pass.

Signed-off-by: david <david@xd.com>

* WIP: align host sharing copy with invitation codes

Clarify sending, copying, entering, renewing and expiring invitation codes in the desktop host panel across five locales. Shared-task dialog tests: 30 passed. Typecheck and both i18n checks passed. Required related test gate remains blocked by missing MSVC link.exe. No Light/Dark visual verification. Local preservation only; do not push before gates pass.

Signed-off-by: david <david@xd.com>

* WIP: align sharing menu states and add joined task management

Add state-aware share, stop-sharing and leave confirmations; expose joined tasks in the join dialog with open and leave actions.

Validation: 123 focused tests, desktop typecheck, i18n and glossary checks passed. Root test:unit:related blocked by missing Windows MSVC link.exe after 554 runner tests passed (8 skipped). Light/dark runtime inspection not performed. Local WIP preservation only; do not push or open a PR until the gate passes.
Signed-off-by: david <david@xd.com>

* WIP: preserve task menu groups when replacing sharing entry

Retain existing options for shared guests while keeping owner-only actions disabled. Prevent guest tag menus from requesting the host catalog.

Validation: 87 focused tests and desktop typecheck passed. CN isolated dev black-box inspection covered host/guest menu entries, guest leave confirmation and cancel, and joined-task management. Guest menu, confirmation and joined list inspected in light and dark. Root related gate blocked by missing MSVC link.exe after runner tests passed. Local WIP only.
Signed-off-by: david <david@xd.com>

* WIP: keep shared task management accessible through a submenu

Expose copy invitation code, manage members, and stop sharing under the active host sharing entry. Preserve the other task menu groups and guest leave confirmation.

Validation: 98 focused tests, desktop typecheck, i18n/glossary checks passed. CN isolated dev light-mode black-box check confirmed the submenu and member panel. New submenu dark-mode inspection not performed; no live member was removed. Root related gate blocked by missing MSVC link.exe after 554 runner tests passed (8 skipped). Local WIP only.
Signed-off-by: david <david@xd.com>

* WIP: show only leave action in shared task guest menu

Targeted sidebar tests (77) and desktop typecheck pass. CN isolated dev black-box check confirms a single leave action and cancellation behavior. Root test:unit:related is blocked by missing Windows link.exe; local preservation only, do not push before the gate passes.

Signed-off-by: david <david@xd.com>

* WIP: unify shared task management panels

Implement the approved three-tab sharing prototype with per-task management, inline confirmations, independent field validation, and aligned copy across five locales.

Validated 152 focused tests, desktop typecheck, i18n checks, and light/dark UI flows in the isolated CN dev instance. Real removal/leave/close mutations were not performed during manual acceptance.

Local preservation only: pnpm test:unit:related is blocked by missing MSVC link.exe in the Windows atomic-rename prerequisite. Do not push or open a PR until the required gate passes.

Signed-off-by: david <david@xd.com>

* test(desktop): provide auth context in task row menu fixture

Preserve row rendering and task menu assertions with the account context required by sharing controls. Required related unit tests and desktop typecheck pass after installing the Windows build toolchain.

Signed-off-by: david <david@xd.com>

* fix(desktop): close remote shares through the owning host

Keep sharing management accessible during pending state lookup. Route remote menu, detail and batch cancellation through the existing host close command; retain failures for retry without account-only fallback and stop after owner or window invalidation.

Validation: 113 focused tests, pnpm test:unit:related, desktop typecheck and diff checks passed.
Signed-off-by: david <david@xd.com>

* test(desktop): align remote menu invariant with owner action guard

Keep asserting that disconnected sessions cannot open a new window, including the combined guest guard. Reproduced the Windows and Linux CI failure locally; 37 focused tests, pnpm test:unit:related and desktop typecheck pass.

Signed-off-by: david <david@xd.com>

---------

Signed-off-by: david <david@xd.com>
```

## #5192 invitation/management subset

```text
commit 10012d69b8f841da497ef7c81a625b59e320ec65
Author: Lizi <jiali@magiclizi.com>
AuthorDate: 2026-09-28T21:48:52+08:00
Committer: GitHub <noreply@github.com>
CommitDate: 2026-09-28T21:48:52+08:00

Merge pull request #5192 from makecindy/cindy/gentle-bohr

feat(shared-task): 支持邀请链接、移动端自动识别与共享管理
```

## #5246 self-join copy fix

```text
commit 69fd194714d043a763f94e82c5cb1e8bb99809e4
Author: DavidShenXD <david@xd.com>
AuthorDate: 2026-09-29T19:30:33+08:00
Committer: GitHub <noreply@github.com>
CommitDate: 2026-09-29T19:30:33+08:00

fix(shared-task): 明确提示房主无需加入自己的共享任务 (#5246)

* fix(shared-task): explain owner self-join on desktop and mobile

Signed-off-by: DavidShen <david@xd.com>

* test(claude): drain background migration before timeout test cleanup

Signed-off-by: DavidShen <david@xd.com>

---------

Signed-off-by: DavidShen <david@xd.com>
```

## Lex-only adaptation

- Desktop IPC exposes only the existing owner/account SharedTask channels; no capability is published by default.
- Invitation secrets stay in fragments/in-memory handoff, and configured endpoint/region checks happen before account API admission.
- Remote task management uses task-scoped peers, preserves existing task mirrors/owner generation fences, and never falls back to ordinary same-account device control.
- The sidebar intentionally keeps the SharedTask group and join entry visible when empty; owned mirrors are de-duplicated from guest rows.
- Validation evidence and known unverified boundaries are recorded in the worker handoff; server deployment, real accounts, Mobile, and real-device Light/Dark inspection remain outside S4D.
