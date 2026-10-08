# SharedTask 附件上传来源与 Lex 适配

语义上限为 v0.1.96-beta f7f265ef2e4316d37a7ce6d4e03006a826e397e4。
本次是 Poker 的本地综合适配，不伪称保留上游 Git Author。

## 采用的上游行为

- sharedTaskMediaContext / mediaTransfer：调用级任务范围，presign-put 追加 sharedTaskId。
- Mobile 附件上传 / picker：sharedTaskId 沿预处理与上传传递。
- sharedTaskDispatch：当前成员 + 同任务 OSS 命名空间准入，下载由 authenticated presign-get 授权。
- outboundMedia：不发送控制端的本地预览路径；编辑保留主机确认的已有附件。
- 不引入 File Peer、依赖或服务端改动。

## Lex 适配

- 保留 SHA256/size 校验、延迟清理、持久发件箱和默认128在途撤权边界。
- 持久发件箱恢复从已捕获目标取任务范围；旧服务端忽略范围时在 PUT 前拒绝。
- 共享任务媒体缓存按 task 分离；主机物化捕获 DbClient/owner/epoch，下载后撤权或
  profile 更换时不得继续写媒体引用；引用补偿使用已有 owner journal。
- 上游的权限单位是共享任务，不是某一物理上传设备。此前要求额外的设备级签名证明而
  将全部新附件拒绝是过度限制，本提交纠正该结论。历史阶段附录是当时记录，当前合同以此为准。
- 语音转文字走既有发起账号的 ASR；上游 mobileVoiceInput.ts 没有 SharedTask 专属参数，
  不能把辅助上传函数等同于生产录音入口。录音作为文件发送走任务附件管线。

## 验证边界

测试覆盖 presign 范围、并发隔离、旧端拒绝、照片/录音文件/文档、预处理、
服务端下载拒绝、主机落盘撤权/profile 切换，以及普通上传回归。原根门禁不包含 localDb/
integration，真实 SQLite dispatch fixture 单跑。未使用真实账号、OSS、设备或服务端部署。

## 真实来源

```text
bca321223d8b88aef67b73c5e072a244737790f2
Author: DavidShen <david@xd.com>
AuthorDate: 2026-09-20T19:58:03+08:00

feat(sharing): share tasks across accounts with unified desktop and mobile flows

Signed-off-by: DavidShen <david@xd.com>
```

```text
9727ac7709cf8369e436fbe03087b7767bf179d6
Author: DavidShenXD <david@xd.com>
AuthorDate: 2026-09-29T20:15:48+08:00

feat(shared-task): 开放协作者决策并防止越权与撤权竞态 (#5245)

* feat(shared-task): allow guest decisions with scoped authorization

Signed-off-by: DavidShen <david@xd.com>

* fix(shared-task): constrain guest approvals and fence migrated requests

Signed-off-by: DavidShen <david@xd.com>

* fix(shared-task): keep guest plan edits off local filesystem

Signed-off-by: DavidShen <david@xd.com>

* test(desktop): stabilize Windows IO and version loading checks

Signed-off-by: DavidShen <david@xd.com>

---------

Signed-off-by: DavidShen <david@xd.com>
```
