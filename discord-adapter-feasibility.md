# Discord-first、DSH-native Adapter 可行性调研

## 状态

- 阶段：探索结论，尚未进入实现
- 目标：构建独立的 Discord-only DeepSeek Harness Adapter，npm 包名暂定为 `@addozhang/dsh-discord`
- 后续决策：以 `openspec/changes/build-discord-native-adapter/` 为准；Milestone 1 不支持 DM、Session 全文搜索或 per-Workspace ACL，Preset 是项目频道默认值，模型切换沿用并明确提示 DSH 的 Host 默认副作用
- 参考实现：Kimaki（Discord → OpenCode）与 dsh-im（IM → DSH）
- 调研基线：
  - Kimaki `e0ba496af5fb29ac2076b97eda42573bb1e988ed`（`kimaki` 0.26.0）
  - dsh-im `71ca5521134c14addc6a1f277ee8c51f09f942b7`（3.1.0）
  - 本机 DSH `0.1.1-rc.2`，对应 tag commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`

## 产品方向

采用 Discord-first、DSH-native 的领域模型，而不是泛 IM 的最低公分母模型：

```text
Discord project channel  → DSH Workspace
Discord thread           → DSH Session
Discord message          → DSH prompt / queue item / interaction response
```

目标不是复制 Kimaki 的所有附属能力，而是首先完成稳定、自然、可恢复的 Discord 编程代理体验。

## 已确认的核心技术事实

### DSH Workspace

当前 DSH Host API 已提供：

- `workspace.list`
- `workspace.create`
- `workspace.rename`
- `workspace.delete`
- `workspace.insertBefore`
- `workspace.insertSessionBefore`
- `workspace.archiveSession`

`workspace.create` 只登记已经存在的目录，不执行 `mkdir`。目录创建需使用可选的 `host.createDirectory` browse capability，或由插件在受限 project root 下安全实现。

### DSH Session

当前 API 已提供：

- `session.list` / `session.search`
- `session.create`，支持 `workspaceId`、`cwd`、预分配 `sessionId` 和 `agentPreset`
- `session.history`
- `session.rename`
- `session.fork`
- `session.prompt`，模式为 `queue` 或 `steer`
- `session.updateQueue`，支持 edit/remove/steer
- `session.cancel`，停止当前 Turn 并保留 pending inbox
- `session.models` / `session.selectModel`
- 图片输入和基于 Session 引用校验的图片读取

### 实时事件与人工交互

`events.mux` 提供：

- `session/event`
- `session/subscribed`
- `session/queue`
- `session/jobs`
- `session/projection`
- `approval/requested` / `approval/resolved`
- `question/requested` / `question/resolved`

`events.host` 提供 Session、Agent、Workspace 和归档状态变化。审批和问题的回答通过原始 `rpcId` 调用 `apiProxy.respond`。当前 DSH wire 只支持审批 `allowed-once` 和 `rejected`，不支持 `Approval always`。

### DSH 插件形态

DSH 使用 Cordis 组合：插件通过 `apply(ctx, config)`、对象插件或 Service class 加载；Host 插件可以直接注入同进程 `ctx.apiProxy`。外部插件通过 profile bundle 的 `cordis.patch.yml` 安装。首个版本应运行于 Web profile，并默认使用同进程 API，而不是绕行本机 HTTP。

## Kimaki 值得复用的设计

### Channel / Thread 映射

Kimaki 的核心设计是 channel=project、thread=session。项目切换由 Discord 频道完成，任务切换由 Discord Thread 完成。此模型是目标产品的基础。

### 流式与工具进度

Kimaki 没有真正突破 Discord 的限制，而是通过状态机适配限制：

1. 全局监听 OpenCode 事件，再按 Session/Thread 分发。
2. 每个 Thread 有串行 action queue，避免事件、入站消息和 UI 操作交错修改状态。
3. `message.part.updated` 先进入 part buffer；未结束的文本通常不立即发送，工具进入 running 时先刷新此前内容并显示工具状态，step/assistant 完成时再强制 flush。
4. 对已发送 part 建立 `partId → Discord messageId` 映射，并在异步发送前先标记，避免并发重复发送。
5. Discord 长文本按 2,000 字符切分，尽量保持 Markdown fence、表格和 Unicode 边界；最终仍有硬截断安全网。
6. typing 状态使用约 7 秒 keepalive，而不是依赖一次 typing 调用。
7. 对 Thread 改名、状态更新和通知做去重/节流，避免 Discord rate limit。
8. 恢复旧 Session 时只重放有限历史，保存已投递 part，避免重启后重复刷屏。

首个版本应采用“事件驱动、节流更新、最终确认”的策略，而不是每个 token 编辑一次 Discord 消息。

推荐的 Discord 渲染状态机：

```text
queued
  ↓
placeholder + typing
  ↓
assistant chunk accumulator ── debounce/coalesce ── edit current message
  ├─ tool/call   → 独立工具状态或紧凑状态区
  ├─ tool/result → 更新对应工具状态
  ├─ approval/question → 暂停普通渲染，显示原生组件
  └─ turn/end    → 最终重排、Markdown 安全切分、补发后续消息
```

必须持久化 `lastDeliveredSeq`、消息分片和 DSH event/part 到 Discord message 的映射；断线恢复时重新拉 `session.history`，不能依赖 rc.2 尚未实现的 `events.mux.since`。

## “插件桥接”的含义

桥接是指在 Discord 和 DSH 不共享同一种数据/交互模型时，由插件完成协议转换，而不是修改 Agent runtime。

### 入站普通文件

DSH `session.prompt` 原生接受文本和图片，但没有任意二进制文件 block。因此插件需要：

1. 从 Discord CDN 下载附件；
2. 校验 host、redirect、大小、类型和超时；
3. 暂存到 Session Workspace 内的受控目录；
4. 把受控本地路径和说明作为文本交给 Session；
5. Turn 完成后按策略清理。

### 出站结果文件

不应扫描模型回复中的任意本地路径。推荐注册一个可信的 model-facing 工具，例如 `discord_deliver_file`：

1. Agent 显式调用并指定文件；
2. 插件校验 Session、Turn、workspace containment、文件类型和大小；
3. 生成一次性 artifact 记录；
4. Discord adapter 领取并上传文件；
5. 记录确定成功、确定失败或结果未知，避免重复发送。

这类转换层就是“插件桥接”。dsh-im 的 `installOutboundArtifactTool` 是可参考实现。

## Reconciliation 层的含义

Reconciliation 是“以 DSH 和 Discord 的当前事实为准，把本地映射恢复到一致状态”的循环，不只是 WebSocket 重连。

本地状态可能写着：

```text
thread T → session S
channel C → workspace W
lastDeliveredSeq = 120
```

但重启后可能出现：

- Discord Thread 被删除、归档或改名；
- Workspace 被 Web GUI 删除或重命名；
- Session 仍在磁盘但未附着 Agent；
- bot 断线期间 DSH 已产生事件；
- Discord 已成功创建消息，但进程在保存 messageId 前崩溃；
- 同一 Session 被别的客户端继续执行；
- approval/question 已经由另一端处理。

Reconciler 启动和重连时执行：

1. 拉取 `workspace.list`、`session.list`；
2. 打开 `events.host`、`events.mux`；
3. 校验 channel↔workspace 和 thread↔session 映射；
4. 对每个活跃 Thread 从 `lastDeliveredSeq` 之后重读 `session.history`；
5. 去重并补发遗漏事件；
6. 将失效映射标为 detached，而不是盲目新建 Session；
7. 重新呈现仍 pending 的 question/approval；
8. 对结果不确定的 Discord 写入做查询/幂等恢复。

其目标是：重复执行安全，断线后收敛，不靠“刚才大概成功了”的内存状态。

## Turn 定义

DSH 中：

- **Step**：一次模型请求，以及它要求执行的工具调用。
- **Turn**：从一条唤醒输入开始，包含零个或多个 Step，直到 Agent 不再欠任何工作。

典型流程：

```text
turn/start
  user/message
  step/start
    模型输出
    tool/call
    tool/result
  step/end
  可能继续下一个 step
turn/end
```

一个用户消息通常启动一个 Turn，但一个 Turn 可以包含多次“模型 → 工具 → 模型”。队列消息通常等待当前 Turn 结束；steer 进入当前 Turn 的下一步；cancel 停止当前 Turn。

## 入站消息策略决定

首个版本采用：

- 普通 Thread 消息默认 `queue`；
- 忙碌时显示排队位置；
- `/steer` 明确将指令加入当前 Turn；
- `/stop` 明确取消当前 Turn并保留排队消息；
- 不实现 Kimaki 的“等待约 3 秒后自动中断并重发”。

理由：默认 queue 更可预测，避免因为 Discord 网络延迟、长工具调用或多人协作而误杀正在执行的工作。显式 `/steer` 与 `/stop` 足以表达纠偏意图，并且直接匹配 DSH 原生 API。

## DSH Web 进程管理

### 结论

可以管理，但不能由“仅运行在 dsh web 内部的插件”完整管理自己的父进程。

如果 Discord bot 本身位于 dsh web 进程内：

- 可以发起 graceful shutdown；
- 但进程停止后 bot 也停止，无法再从 Discord 收到 `/start`；
- 自己拉起替代进程再退出存在端口、锁、生命周期和升级竞态，不应作为正式架构。

要支持远程 start/stop/restart，必须有一个独立于 dsh web 生命周期的 supervisor：

```text
Discord Control Daemon / Product CLI
  ├─ 保持 Discord Gateway 在线
  ├─ spawn: dsh web --profile <dedicated-profile> --host 127.0.0.1 --port <port>
  ├─ health/readiness: host.describe
  ├─ SIGTERM graceful stop
  ├─ waitForExit + bounded grace + final kill
  ├─ restart backoff / crash-loop breaker
  └─ 连接 DSH HTTP/WebSocket API
```

这会把交付物从“纯 DSH 插件”提升为“外部 supervisor + DSH 插件/配置包”。如果首个版本不需要在 DSH 完全停止后仍能通过 Discord 启动它，则可先使用纯插件模式，只实现状态查看和受控 restart-required 提示。

## DSH 升级

### 当前事实

`dsh plugin --profile <name> ...` 只管理 profile 中的插件依赖，不升级 DSH CLI 本体。dsh-im 的更新器也只升级 `@xmanrui/dsh-im`，并明确把最终状态设为 `restart-required`；它不主动重启 Host。

### 推荐策略

不要从正在运行的 DSH 插件中直接覆盖当前 DSH 安装。生产方案应由外部 supervisor 负责：

1. 检测 DSH 的安装来源和当前精确版本；
2. 查询可信 registry，展示目标版本与变更信息；
3. 要求高权限用户二次确认，确认令牌有 TTL；
4. 停止接收新任务并等待/取消现有 Turn；
5. 安装精确版本，而非模糊 `latest`；
6. 启动新版本并执行 `host.describe` 和兼容性探测；
7. 验证插件 profile 可以加载；
8. 失败时回滚到前一精确版本并恢复服务。

更稳妥的部署模型是由产品管理一份私有、固定版本的 DSH runtime，而不是修改用户全局安装：

```text
product/releases/dsh-0.1.1-rc.2/
product/releases/dsh-next/
current → 当前版本
```

先安装到新目录，健康检查通过后切换 `current`，这样才有可靠回滚。全局 npm/pnpm/Homebrew 安装的原地升级不宜从 Discord 直接自动执行。

首个 milestone 不实现 DSH 自升级；最多实现 `/host version` 与“检测到新版本”的提示。升级属于后续独立 milestone。

## 安全边界

- Workspace registry 不是授权列表；不得向所有 Discord 用户暴露所有路径。
- 每个 Guild/Channel 只能看见策略允许的 Workspace。
- 创建目录必须限制到 canonical allowlisted roots，并防 symlink escape。
- 一个 Session 默认只允许一个 writable Discord Thread；其他绑定应为只读 watch，或显式 takeover。
- question/approval 必须绑定 session、turn/rpcId、thread 和允许回答的 actor。
- 所有 Discord 入站 payload 和 DSH 出站 payload都在边界验证。
- 消息去重必须持久化，不能只依靠进程内 Set。
- Bot token 进入 DSH credential store或受保护文件；绝不回传到浏览器或日志。
- DSH 为 pre-1.0，依赖应精确锁定，升级需 contract tests。

## Milestones

### Milestone 1：核心 Discord Session 体验

包含：

- 独立 Discord-only DSH 插件；
- Discord Gateway/REST 和 Bot token 配置；
- Discord 原生 slash commands、autocomplete、buttons、select menus、modals；
- 绑定已有 DSH Workspace 到 project channel；
- Channel→Workspace、Thread→Session；
- 新建/恢复/搜索 Session；
- 默认 queue，显式 `/steer` 和 `/stop`；
- 高质量文本流式呈现和工具进度；
- 图片输入；
- approval once/reject；
- user questions；
- model、reasoning 和 Agent Preset 选择；
- Skill 调用；
- 严格 RBAC、workspace 可见性策略；
- 重连、历史补偿、持久化幂等；
- Host 状态和版本查看。

### Milestone 2：受控创建与权限增强

包含：

- 在配置好的 project roots 下创建目录；
- 可选 `git init`；
- 注册并绑定新 DSH Workspace；
- `Approval always`，前提是 DSH 增加安全、持久化、可审计的授权规则 API；
- Workspace 的原生分页/搜索选择器；
- 更完整的管理员审计。

### 后续可选 Milestone

- 普通文件入站与结果 artifact 回传；
- 外部 DSH Session 自动镜像；
- DSH/插件受控升级与外部 supervisor；
- Worktree 生命周期；
- 定时任务。

明确不做：

- `/diff` 公共查看页；
- Session 公开分享页；
- 语音；
- VS Code；
- 屏幕共享；
- Tunnel；
- 将 subagent 转为独立顶层 Session；
- Kimaki 的自动三秒中断策略。

## 推荐决策

1. 采用独立 Discord-only 产品方向。
2. 采用 Channel→Workspace、Thread→Session，不采用 bot-global Workspace。
3. 默认消息进入 DSH queue；纠偏与停止必须显式操作。
4. 首个版本重点投入流式呈现、工具进度、交互归属和恢复一致性。
5. Workspace 创建、Approval always 放入 Milestone 2。
6. Worktree、定时任务、升级和进程 supervisor 后置。
7. 不做 diff/share、voice、VS Code、screenshare、Tunnel、subagent 提升。

## 主要源码依据

- Kimaki README：https://github.com/remorses/kimaki/blob/e0ba496af5fb29ac2076b97eda42573bb1e988ed/README.md
- Kimaki Channels & Threads：https://kimaki.dev/docs/core-concepts/channels-threads
- Kimaki Commands：https://kimaki.dev/docs/reference/commands
- Kimaki Message Handling：https://kimaki.dev/docs/core-concepts/message-handling
- Kimaki Session Runtime：https://github.com/remorses/kimaki/blob/e0ba496af5fb29ac2076b97eda42573bb1e988ed/cli/src/session-handler/thread-session-runtime.ts
- Kimaki Discord utils：https://github.com/remorses/kimaki/blob/e0ba496af5fb29ac2076b97eda42573bb1e988ed/cli/src/discord-utils.ts
- dsh-im README：https://github.com/xmanrui/dsh-im/blob/71ca5521134c14addc6a1f277ee8c51f09f942b7/README.md
- dsh-im Harness client：https://github.com/xmanrui/dsh-im/blob/71ca5521134c14addc6a1f277ee8c51f09f942b7/src/channels/shared/harness-client.mjs
- dsh-im workspace store：https://github.com/xmanrui/dsh-im/blob/71ca5521134c14addc6a1f277ee8c51f09f942b7/src/channels/shared/bot-workspace-store.mjs
- DSH architecture：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/docs/architecture.md
- DSH Host API Proxy：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/host/apiproxy/README.md
- DSH Workspace API：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/host/apiproxy/src/api/workspace.ts
- DSH Sessions API：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/host/apiproxy/src/api/sessions.ts
- DSH Events API：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/host/apiproxy/src/api/events.ts
