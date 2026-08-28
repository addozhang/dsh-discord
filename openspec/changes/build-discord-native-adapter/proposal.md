## Why

现有通用 IM adapter 将 Workspace 绑定在机器人级配置上，没有充分利用 Discord 的频道与线程结构，导致项目切换、并行任务、历史恢复和交互操作不够自然。我们需要一个独立的 Discord-first、DSH-native Embedded plugin，让用户仅通过 Discord 原生交互安全地操作当前 `dsh web` Host，同时把可靠的流式回答与工具进度作为首版核心体验。

## What Changes

- 新增一个运行在现有 `dsh web` 进程内的 Discord-only Cordis 插件，默认通过同进程 `ctx.apiProxy` 访问当前 Host。
- 建立 `Discord project channel → DSH Workspace`、`Discord thread → DSH Session` 的持久映射；不使用 bot-global 当前 Workspace。
- 通过 Discord slash commands、autocomplete、buttons、select menus 和 modals 列出并绑定已登记 Workspace，以及创建、恢复和控制 Session；Session 搜索后置到下一里程碑。
- 普通 Thread 消息始终以 DSH `queue` 模式提交；`/steer` 和 `/stop` 是显式控制操作，不实现自动中断。
- 消费 DSH Session/Host 事件，提供节流的流式回答、工具进度、typing keepalive、长消息与 Markdown 安全分段，以及 Turn 完成后的最终定稿。
- 将 DSH 的一次性审批和用户问题映射到 Discord 原生交互，并严格校验 Session、Thread、请求和操作者归属。
- 支持图片输入、模型/推理等级选择、Agent Preset 选择和 Skill 调用。
- 增加显式 Guild allowlist、Discord 成员/Workspace 管理员/Host operator 分级授权、Workspace 元数据披露策略、持久化消息幂等和启动/重连后的状态对账。
- 提供当前 Host 连接状态和版本查看，但不管理、启动、停止、重启或升级 `dsh web`。
- 首个里程碑不包含 Discord DM、新建目录/Workspace、per-Workspace ACL、Session 搜索、Approval always、普通文件桥接、结果文件回传、外部 Session 自动镜像、Git worktree、定时任务、公开 diff/share、语音、Tunnel、远程 VS Code/屏幕共享或 subagent 提升。

## Capabilities

### New Capabilities

- `plugin-foundation`: Discord-only bundle、Host 插件生命周期、配置和凭据边界，以及同进程 DSH API 适配。
- `discord-transport`: Discord Gateway/REST、slash command 注册、原生组件、入站规范化、重连与限流处理。
- `access-policy`: Guild allowlist、用户与角色授权、拒绝 DM，以及 Workspace 元数据披露策略。
- `binding-state`: Channel/Workspace、Thread/Session、消息投递和单一可写所有权的持久状态。
- `workspace-control`: 在 Discord 中发现、筛选并绑定当前 DSH Host 已登记的 Workspace。
- `session-control`: Session 新建和恢复、默认 queue、显式 steer/stop，以及模型、频道默认 Preset 和 Skill 控制。
- `stream-renderer`: DSH 增量文本和工具事件到 Discord 的节流、分段、去重与最终呈现。
- `interaction-routing`: DSH approval/question 到 Discord buttons、select menus 和 modals 的安全双向路由。
- `reconciliation`: 启动和重连时对 DSH、Discord 与插件持久状态进行校验、历史补偿和收敛。

### Modified Capabilities

无。当前仓库没有既有 OpenSpec capability，本次全部为新增能力。

## Impact

- 新增 npm 包 `@addozhang/dsh-discord`，作为 DSH bundle 安装到 `web` profile，并精确锁定支持的 DSH pre-1.0 版本。
- 新增 Discord Gateway/REST 依赖和本地持久化依赖；Bot token 必须进入 DSH credential store 或等价的受保护存储，不能出现在普通配置、浏览器响应或日志中。
- 依赖 DSH `0.1.1-rc.2` 的 Workspace、Session、event mux、approval/question、model、preset 和 skill 契约；通过 contract tests 防止版本漂移。
- 不修改 DSH core，不管理 DSH 进程，也不升级 DSH。
- 远程 Discord 用户将能够触发本机 Agent 和工具，因此 RBAC、Workspace 可见性、交互所有权和幂等恢复是发布阻断条件，而非后续增强。
