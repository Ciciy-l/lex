# S4M Mobile SharedTask source appendix

Current task entry: S4M Mobile shared-task management, invitation handoff, guest task presentation, and digest-only clipboard invitation history. This stage does not publish the production host capability, add a server/native dependency, or implement the later authenticated attachment-upload contract. Only the Mobile hunks listed by the S4M change are adapted; the final upstream tag is a semantic ceiling, not a wholesale file copy.

The source records below preserve the complete local Git `%B`, author/date, committer/date, and trailers for the selected upstream objects. Lex-only changes retain the local Poker author and DCO.

## Adopted source records

### `bca321223d8b88aef67b73c5e072a244737790f2`

```text
commit bca321223d8b88aef67b73c5e072a244737790f2
Author: DavidShen <david@xd.com>
AuthorDate: 2026-09-20T19:58:03+08:00
Committer: DavidShen <david@xd.com>
CommitDate: 2026-09-21T02:31:46+08:00

feat(sharing): share tasks across accounts with unified desktop and mobile flows

Signed-off-by: DavidShen <david@xd.com>
```

### `8ecf37cbe547cf72a8e4d1f75e9573f0753c9316`

```text
commit 8ecf37cbe547cf72a8e4d1f75e9573f0753c9316
Author: DavidShen <david@xd.com>
AuthorDate: 2026-09-28T13:13:02+08:00
Committer: DavidShen <david@xd.com>
CommitDate: 2026-09-28T14:05:17+08:00

feat(shared-task): support invitation links and account nicknames

Signed-off-by: DavidShen <david@xd.com>
```

### `bc2cab9e6a8dea96800602c0c55d7146f5cd769a`

```text
commit bc2cab9e6a8dea96800602c0c55d7146f5cd769a
Author: DavidShen <david@xd.com>
AuthorDate: 2026-09-28T16:34:32+08:00
Committer: DavidShen <david@xd.com>
CommitDate: 2026-09-28T16:34:32+08:00

feat(shared-task): complete sharing management and automatic invitation admission

Signed-off-by: DavidShen <david@xd.com>
```

### `6a140a3dff2869875e2326ff4ac6a32369058fba`

```text
commit 6a140a3dff2869875e2326ff4ac6a32369058fba
Author: DavidShen <david@xd.com>
AuthorDate: 2026-09-29T19:03:47+08:00
Committer: DavidShen <david@xd.com>
CommitDate: 2026-09-29T19:03:47+08:00

fix(mobile): 持久化共享任务邀请摘要，避免冷启动重复提示

Signed-off-by: DavidShen <david@xd.com>
```

### `9f35117bf7b30f00634760a6a2dce0fb036ff179`

```text
commit 9f35117bf7b30f00634760a6a2dce0fb036ff179
Author: DavidShen <david@xd.com>
AuthorDate: 2026-09-28T20:07:05+08:00
Committer: DavidShen <david@xd.com>
CommitDate: 2026-09-28T20:07:05+08:00

fix(shared-task): parse titled invitations and dedupe explicit links

Signed-off-by: DavidShen <david@xd.com>
```

### Semantic ceiling `f7f265ef2e4316d37a7ce6d4e03006a826e397e4`

```text
commit f7f265ef2e4316d37a7ce6d4e03006a826e397e4
Author: Lizi <jiali@magiclizi.com>
AuthorDate: 2026-09-29T23:23:56+08:00
Committer: GitHub <noreply@github.com>
CommitDate: 2026-09-29T23:23:56+08:00

Merge pull request #5247 from makecindy/cindy/tender-torvalds

fix(mobile): 持久化共享任务邀请摘要，避免冷启动重复提示
```

## Lex adaptation boundary

- Mobile uses the existing account/region owner-generation fence and `apiFetch` retry path; it does not announce a production `shared-task-v2` host capability.
- Invitation secrets remain fragment/in-memory values. Clipboard persistence stores only SHA-256 digests, bounded per account and region.
- Guest task navigation uses the scoped shared-task peer while owner management uses the existing same-account host route.
- New guest raw OSS upload and voice-upload entry points remain unsupported until the authenticated verifier contract is available; existing authorized task history media remains readable.
- Real devices, native scheme registration, public invitation pages, server deployment, and production host capability remain unverified/out of scope.
