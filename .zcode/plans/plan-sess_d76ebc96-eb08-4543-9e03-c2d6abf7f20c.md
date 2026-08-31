# `/session resume` 实现计划（16.44，修订版：workspace 作用域 + 控制频道拒绝）

## 需求（你的两条约束合并）

1. **general（管理/控制频道）**：明确**拒绝** `/session resume`——它不是会话面；拒绝文案指引到工作区频道
2. **工作区频道（有 channel→workspace 绑定的频道）**：允许 resume，且候选**只列该 workspace 的会话**（`SessionSummary.cwd` === 绑定 workspace 的注册路径），不做全量列表
3. 输入即过滤：autocomplete 按 session 标题/ID 大小写不敏感过滤（rc.2 `sessions.list` 行的 `projections.values.title`，缺省 = 未命名）
4. `/session new` 永久移除：@提及即 canonical 新会话路径

## 实现

### 1. face 层（已完成落盘）
`sessions.list` 类型放宽为 `SessionSummaryShape[]`（sessionId/updatedAt/running/blank/cwd/projections.values.title 防御性读取）+ `listSessionSummaries` wrapper（`listSessionIds` 保留给 reconciliation）

### 2. session-resume.ts（已完成落盘）
`buildResumeCandidates(sessions, {workspacePath, boundSessionIds, query, nowMs})`：过滤 blank + 已占用 + **cwd ≠ workspacePath 的会话**（无 cwd 不归属、不提供）、title/ID 过滤、updatedAt 倒序——5 个单测已更新并通过

### 3. 控制频道拒绝（新增，本次修订核心）
- index.ts `resumeSession`：解析 adapter 类目下的 `general` 控制频道（GET guild channels → category 下名为 general 的子频道，与 ensureCategory 同判据）→ `parentChannelId === 控制频道` → 返回 `{outcome:'refused-control-channel'}`
- 路由器映射该 outcome → 双语 copy `sessionResumeControlChannel`："general 是控制频道，不承载会话——请到工作区频道使用 /session resume"

### 4. 注册契约 + 路由器（其余按已批准计划）
- `commands.ts`：`session` grouped（仅 resume 子命令，session 参数 autocomplete）
- 路由器 autocomplete：`session` 分支 → `resumeCandidates(query)` → type 8 候选（含 description：相对时间 + 🟢running）
- 路由器 slash：`session resume` → channelBinding 缺失或控制频道 → 拒绝；resumeSession 执行 → ephemeral 确认
- 新 deps：`resumeCandidates(query)`、`resumeSession(input)`

### 5. 组合根（index.ts，已完成大半）
- `resumeCandidates`：listSessionSummaries + buildResumeCandidates（排除 threadTable 已占用会话）+ filterResumeCandidates 截 25
- `resumeSession`：已占用检查 → 标题解析 → 锚定帖 → 建线程 → 绑定写入；失败 rpcLog 可见

### 6. 测试
- session-resume 单测（5 个已过）+ 新增 workspace 作用域用例（其他 workspace 会话永不出现）
- twin E2E ×3：autocomplete 候选含种子标题；resume → 新线程 + 绑定 + 确认；general 频道 resume → 拒绝文案

### 7. 文档/spec
- design §13：`/session new` DROPPED；resume 行更新（autocomplete + 控制频道拒绝）
- session-control spec：Resume Sessions 实现化；新增"控制频道不承载会话"scenario
- tasks 16.44；README 命令表 + 已知限制（中英）

## 明确不做（v1）
SessionOwnerStore 持久接线（16.28 维持）；`session.search` 内容搜索（backlog）；冷收养历史展示（无 history RPC）

## 验证
全门禁 → pack 部署 web profile → 实测：general 中 `/session resume` 被拒（指引到工作区频道）；workspace 频道中候选只含本 workspace 会话 → 输入过滤 → 选中 → 新线程续聊命中旧上下文