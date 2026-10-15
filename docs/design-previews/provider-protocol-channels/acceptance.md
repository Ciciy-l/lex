# 协议渠道表单本地验收

2026-10-15，Windows x64；分支 `fix/cindy-v0108-stability-provider-ux`，
基于 `0db3bd88e9a357e9986fab958a25d0f8bf54354f` 的未提交实现。通过
`pnpm restart:desktop:remote --region=global --isolated=cindy-v0108-ux` 启动，
取得 `DESKTOP_DEV_VERDICT=ready`。页面显示对应分支构建标识；使用独立 profile、
跳过登录、假密钥与 `127.0.0.1` 模型服务，没有使用个人供应商账号。

操作使用真实 Electron 界面和 Main IPC，通过开发实例 CDP 点击、输入、键盘与截图；
不是组件替身。伙伴抽屉关闭另以系统窗口坐标点击，再读取窗口树确认关闭。

| 场景 | 实际结果 |
| --- | --- |
| 同协议两个渠道 | Primary/Backup 各自 URL/key/模型草稿保留；同名模型不丢来源 |
| 测试与发现 | 真正向本机服务发送 Responses POST 和 models GET，显示连接成功并添加模型 |
| 保存与重新打开 | 两渠道持久化；密钥输入保持空白，使用 Main 已存密钥仍可连接 |
| 专用配置往返 | 渠道与专用表单两边草稿均保留 |
| 未保存关闭 | Esc 出现确认，继续编辑保留草稿，放弃后关闭 |
| 预设替换 | OpenAI API 预设取消替换保留名称；确认替换填入两协议；再关闭可正常丢弃 |
| 键盘 | 连续 18 次 Tab 焦点保持在对话框内 |
| 失败反馈 | 本机服务返回 401 后显示安全中文错误，不展示原始模拟错误或假密钥 |
| 窄窗 | 680×760 列表/详情/返回可操作，保存按钮在视口内，内容可滚动 |
| 浅色/深色 | 实际通过通用设置切换，两模式均已查看截图 |
| 伙伴抽屉关闭 | 在标题拖动区内真实点击 X 后，抽屉消失，任务窗口保留 |

验收发现保存按钮错误显示 `common.save`，已改为现有正确译文。预设自动化首次在
确认框退出动画中发送 Esc，脚本等待超时；补上确认框隐藏等待后完整操作通过。
两类问题的原始证据保留，不能将初次脚本超时报告为操作通过。

![浅色渠道编辑](../../assets/provider-protocol-channels/light.png)

![深色渠道编辑](../../assets/provider-protocol-channels/dark.png)

![深色窄窗详情](../../assets/provider-protocol-channels/narrow-dark.png)

设计依据：`DESIGN.md` §2/§10 的主题语义色、§4 的表单/对话框结构、§5 的点击目标和
圆角分类；采用现有 Button/Input/Select，不新增硬编码色或设计 Token。

边界：已连接的 Android 平板没有可用 Lex/Expo 开发客户端，本机也无可用模拟器；
因此本轮手机验证限于本地单测，未做实机触控、键盘弹起、弱网重连或两端模型切换。
未进行真实供应商计费请求、SSH 会话、四引擎实测对话、Android 覆盖升级或 macOS/Linux
界面验收。伙伴群设置关闭有组件回归，未创建真实群聊点击。桌面开发实例与假服务验收后
正常退出；未关闭正式 Lex 或宿主 Cindy。
