# Release verification checklist (15.9–15.12)

Steps that require a real Host profile and a dedicated non-production Discord
Guild. Everything automatable has already passed: 502 tests / 77 files,
typecheck, strict lint, Host + client builds, `pnpm pack` verification, and a
clean `pnpm audit`.

## Prerequisites

- `sudo chown -R 501:20 ~/.npm` (npm's default cache has root-owned files;
  pnpm and `--cache <dir>` work around it, the profile install does not).
- `dsh 0.1.1-rc.2` CLI available on PATH.
- A dedicated Discord application + bot, invited to a **non-production** Guild
  with the intents the adapter requests (Guilds, GuildMessages, GuildMembers,
  MessageContent for the sandbox guild only).
- A test bot token to place into the DSH credential reference
  `DSH_DISCORD_BOT_TOKEN` (never into the settings document).

## 15.9 Disposable profile install

1. `mkdir /tmp/dsh-profile && pnpm pack --pack-destination /tmp`
2. Install the packed tarball into a disposable Web profile per dsh docs
   (`dsh profile add`/plugin install path) and start it.
3. Verify:
   - plugin activates (cordis diagnostics show `dsh-discord` with all five
     injected services; startup validation did not refuse);
   - settings card renders under Plugins → Discord;
   - the token reference shows only `configured`/`source`/`writable` — no
     value anywhere in the card, settings document, or logs;
   - unload/disable removes the card and the status RPC channel cleanly
     (no post-disposal errors in the log);
   - the adapter refuses Host process management: no admin/job/plugin APIs
     surface through any adapter command or RPC endpoint.
4. Record the profile path and discard it afterwards.

## 15.10 Manual E2E (dedicated Guild)

Run exactly once in this order, noting any duplicate output:

1. `/project bind <workspace>` in a test channel (administrator).
2. `@bot <task>` in that channel → Thread + Session created.
3. Watch streaming: one edited head message, tool activity rows, typing.
4. Submit a second prompt while the first runs → `/queue list` shows it.
5. `/steer <nudge>` mid-turn, then `/stop` → turn ends, queue preserved.
6. Have DSH trigger an approval → Allow once / Reject round trip; then a
   question → select + "Other…" modal + submit.
7. Restart the dsh process mid-idle → reconciliation: no duplicate Discord
   messages, bindings intact, uncertain prompts reported (not silently
   resent).
8. `/session resume` → new writable Thread; old Thread keeps history only.

## 15.11 Isolation

1. Allow a second Guild; verify independent bindings (`/project info` in both).
2. From an unconfigured Guild: `@bot` mention must produce nothing.
3. From a DM: nothing (no Guild context → rejected at ingress).
4. An unauthorized member clicking a stale approval/question button gets an
   ephemeral denial; controls stay pending.
5. An unauthorized bot's messages must be ignored end to end.

## 15.12 Spec-vs-implementation review (prepared for human review)

Requirement → primary evidence:

| Spec requirement | Evidence |
| --- | --- |
| Guild allowlist, deny-first, DM rejection | `test/gateway-ingress*`, `test/policy*` |
| One bot token via credentialRef, redaction | `test/credential.test.ts`, `test/adapter-status*` |
| Settings namespace + last-known-good | `test/settings.test.ts`, `test/card-form.test.ts` |
| Fail-loud startup validation | `test/startup.test.ts`, `test/lifecycle.test.ts` |
| Gateway lifecycle, terminal closes | `test/gateway*` |
| REST adapter, route queues, commands | `test/rest*`, `test/commands*`, `test/selector*` |
| Durable intents, revisions, retention | `test/intents*`, `test/retention*`, `test/effect-machine*` |
| Workspace/session flows | `test/project-*`, `test/session-*`, `test/task-admission*` |
| Stream renderer, splitting, fences | `test/render*`, `test/splitter*`, `test/outbound*` |
| Approval routing | `test/approval-*.test.ts` |
| Question routing | `test/question-*.test.ts` |
| Reconciliation | `test/reconcile-*.test.ts` |

Any deviation found during 15.9–15.11 is a finding for human review — do not
ship automatically.

## 15.10 进行中状态（下次会话从这里继续）

已完成：插件激活/卡片渲染/本地化/token 零泄露；allowlist 已配置（Agents Hub 1517134847850709032 + owner 983289424819417089）；9 命令已注册；管理通道端点（status/connect/guilds/credentials.set）host 侧就绪；斜杠 dispatch 骨架已接（deferred ack + ephemeral followup，/project list+bind）。

**当前卡点**：/project list 无响应，诊断日志未触发——交互未到达 routeInteraction。Gateway TLS 连接存在但 identify 未验证。
**下一步排查**：1) 确认 Discord 中 DSH 是否显示在线（区分 identify 失败 vs dispatch 断点）；2) 在 ingress.accept 前加 dispatch.t 日志定位；3) 检查 GATEWAY_INTENTS 位组合（33280=0x8200：guilds+guild_messages+message_content? 需核对 guild_members 1<<1 是否被开发者门户特权开关允许——4014 会静默断连）。
**测试后**：Reset bot token（已在本会话暴露）。

## 15.10 调试快照（会话截止时）

- 部署链路全通：插件激活/卡片/本地化/token 零泄露 ✓；intents 门户开关已开；allowlist 已持久化；命令注册 PUT 重放 200（9 命令已在 Guild）。
- **卡点**：适配器 Gateway 连接后进入 4000（unknown error）close 循环，状态卡「连接中」；裸 Node 脚本（同 token+intents 33283）identify 可 READY——差异在 dsh 进程内的会话续接/identify 细节。
- **下一步**：1) gateway.ts 加 HELLO/IDENTIFY/READY 诊断（已加 close:4000 日志于 /tmp/dsh-web-test.log）；2) 对比裸脚本与 gateway.ts 的 identify 载荷（properties/intents/token 来源）；3) 怀疑点：resume 会话过期→op9→4000 循环、tokenProvider 竞态返回旧值、socket 事件翻译遗漏。
- 插件安装注意：pnpm 对同名同版本 tarball 跳过重装——必须 `pnpm remove` 后再 add（已多次踩坑）。

## 15.10 调试快照 2（/project list 双调用 + ack 失败）

- 实测：/project list 触发 routeInteraction 两次（同 interactionId）——① routeEvent→routeInteraction（无 token，被 token 检查拦下）② handleDispatch 直调（有 token）。
- 第二次调用 ack POST 静默失败（无 workspace.list raw 日志、无 followUp）——需在 ack 后记 outcome 日志定位。
- **修复方向**：删除 routeEvent 内对 interactions 的 routeInteraction 转发（compose.ts:91 附近 kind 分支），只保留 handleDispatch 直调路径（带 token）；ack/followUp 处补结果日志。
- 注意：diagnostics console.error 已在 index.ts type-2 分支与 compose handleDispatch（见 15.10 快照 1、2）。

## 15.10 调试快照 3（workspace.list 挂起）

- 双调用已修复：现在单次 dispatch、token 正常携带、ack 成功（type 5 ephemeral）。
- **新卡点**：`apiProxy.workspace.list({rpcId, payload:{}})` 在宿主进程内 await 后**永不返回**（无 reject），导致 followUp 永不发出。
- **下一步**：1) 确认嵌入式宿主内 apiProxy.workspace.list 的正确调用姿势（RpcRequest 是否需完整 rpcId 品牌/或应改走 cordis service 注入的 workspace 注册表直读）；2) 给调用加超时+日志；3) 或改用 REST 端点（/api/... 经 loopback）。
- 提醒：测试后 Reset bot token。

## 15.10 调试快照 4（快照 3 诊断修正 + 信封解析修复，已重新部署）

**对快照 3 的修正**：`{rpcId, payload}` 调用姿势本来就是对的（`ctx.apiProxy` 即宿主直连
ApiProxyService，web profile 的 `api-gateway` 行；`workspace.list` 是同步 resolve 的直连
实现，不可能挂起）。「挂起」是从无日志反推的误诊——真正的问题是两处确定性缺陷：

1. **信封解析形状错误**：直连返回 `RpcResponse`＝`{rpcId, result:{ok, value:{items}}}`，
   代码却读 `listed?.payload?.workspaces`（永远 undefined）；`submitPrompt` 读
   `response?.payload?.accepted` 同错（会导致所有 prompt 永远 `unknown`）。
2. **followUp 静默失败**：REST 客户端对 4xx 是 **resolve（非 reject）**，`void
   rest.request(...)` 会把 followUp 被拒（如 404）无声吞掉——与「挂起」的表象一致。

**修复（commit: fix: parse apiProxy RpcResponse envelope…）**：
- 新模块 `src/dsh/api-proxy-face.ts`：正确的 `result.ok/value` 解析；`withRpcTimeout`
  有界窗口（catalog 5s / prompt 30s，超时→`unknown`，绝不让 handler 无声卡死）；
  `createWorkspaceCatalogPort` 复用已测的 `createProjectListView`（脱敏标签/分页）；
  `promptSession` 返回 sanitized 的 `rejected.code`（如 `session-not-found`）。
- `routeInteraction`：每个阶段 rpcLog 到 stderr（`discord_slash_dispatch` /
  `discord_project_list_start` / `discord_workspace_list_*` / `discord_followup_failed`）；
  followUp 改为 await+记日志；handler try/catch 兜底，失败也回 ephemeral 错误提示（fail-visible）。

**部署状态**：518 tests / 79 files、typecheck、strict lint 全绿；`pnpm build` + pack 后已按
「先 remove 再 add」重装进 web-test profile（新版含 `discord_project_list_start` 诊断行）。
web-test 实例已用新构建重启（token 经旧进程 env 静默交接，未在任何输出中暴露），
日志 `/tmp/dsh-web-test.log`，启动干净。

**下次会话从这里继续**：
1. 在测试频道执行 `/project list`，预期日志序列：`discord_slash_dispatch` →
   `discord_project_list_start` → （无 reject）→ Discord 出现 ephemeral 工作区列表。
   若见 `discord_workspace_list_rejected`/`discord_followup_failed`，按 code 定位。
2. `@bot <任务>` 提交后注意 `discord_prompt_submit_rejected` code——若 `session-not-found`
   属预期：提交流程还差 session.create 前置（design §149 预分配 Session ID），是下一里程碑。
3. 测试后 **Reset bot token**（已多次跨会话暴露）。

**✅ 已验证（同会话）**：`/project list` 在测试频道返回完整 ephemeral 工作区列表
（5 个工作区，脱敏 `ws:<uuid>` 引用 + 消重标签）。日志序列与预期一致：
`discord_slash_dispatch` → `discord_project_list_start`，无 reject、无 followup 失败。
15.10 的 list 卡点关闭。

**下一增量（按 15.10 E2E 顺序）**：
1. **`/project bind` 实接**：`createProjectBindFlow`（两阶段 plan/commit + revision 围栏）
   已就绪且有测试，routeInteraction 的 bind 桩需换成：options 取 `ws:` 引用 →
   plan（AccessDecision + catalog resolve）→ 确认按钮（type 3 组件走 registry，
   与 approval 点击同通道）→ commit 写 `bindingStore`。注意 bindings 目前是进程内
   Map（重启即失，15.10 步骤 7 的 reconciliation 依赖持久化时再接 storageDomain）。
2. **`@bot` 提交前置**：session.create（design §149 预分配 Session ID），否则
   `session.prompt` 对未知 sessionId 一律 `session-not-found`。
3. 测试后 **Reset bot token**。

**✅ bind 已实接（同会话，commit 4d804ed，待 Discord 实测）**：
`/project bind workspace:<ws:id>` → 鉴权（evaluateAuthorization）→ plan（catalog
resolve，畸形/未知引用一律 `stale` fail-closed）→ ephemeral 确认/取消按钮（custom_id
为不透明 registry id，plan 存 registry context，不上线材）→ type 3 点击先查 bind
context：type 6 deferred ack 保牌、非本人点击 ephemeral 拒绝且按钮保持 pending、
commit 走 revision 围栏（stale-revision 提示重跑）。
`workspaceForChannel` 同时修正为按真实 guildId 建 key（旧代码用空 guildId，
bind 后 mention 流程会找不到绑定）。`createWorkspaceResolver` 带 5 个新测试；
全量 523 tests / lint / typecheck 绿；已重新 pack + remove/add 部署并重启（日志同
/tmp/dsh-web-test.log）。
**实测路径**：`/project bind workspace:<从 list 复制>` → 按钮 → 确认 → `✅ 已绑定…`；
再 `/project info` 与 `@bot` mention（预期先报 `discord_prompt_submit_rejected:
session-not-found`，指向下一增量 session.create）。

**✅ bind 实测通过 + 工作区频道自动供给（同会话）**：确认按钮后返回
`✅ 已绑定…（修订 1）`。用户新增需求已实现：bind 成功后在 DeepSeek Harness
category 下确保同名频道（标题 slug；非 ASCII 标题回退原名）并自动绑到该工作区；
名字被其他工作区占用时建 `-2` 兄弟频道，绝不抢占（`planWorkspaceChannel` 纯函数
+ 测试）。成功 ephemeral 附 `<#频道>` 链接；供给失败不影响绑定本身。
`ensureGuildChannels` 与工作区频道共用 `ensureCategory`。已部署并重启。
**待实测**：重跑 `/project bind` 确认返回带频道链接、Discord 出现 `#tmp` 频道且
mention 在其中生效（仍预期 session-not-found）。**Reset bot token**。

## Kimaki 命令设计借鉴（已落地 + 路线图）

参考：kimaki `main` 分支（`cli/src/discord-command-registration.ts`、`cli/src/commands/*`、
`website/src/docs/docs/reference/commands.mdx`）。核心模型 channel=project、thread=session
与我们一致。

**已落地（commit ad8e1c7）**：
1. **Live autocomplete**（Kimaki `/resume`/`/add-project` 模式）：`bind workspace` 与
   `list query` 注册 `autocomplete: true`，type 4 交互以 type 8 回 catalog 实时候选
   （复用 /project list 的脱敏标签 + filterAutocomplete，≤25 条）——ID 从此不用复制粘贴。
   发现仍受成员鉴权门控：非成员 0 候选。
2. **`/project info`**：描述本频道绑定（脱敏身份 + 修订 + 绑定人）；canonical path 仅
   对经验证的 workspace-administrator 渲染（`readWorkspaceDetail` 内存携带，disclosure
   决定渲染）；未绑定/非成员给精确指引（Kimaki 式 context guards）。

**路线图借鉴（下一里程碑起）**：
- `/session resume session:` autocomplete ← `session.list`（需要 thread 上下文过滤）。
- Kimaki 的 reply-affordance 按钮模式：mutating 命令的回复都带操作按钮（/queue 的
  Remove、tasks 的 cancel）——我们 bind 已有；`/queue remove` 接上时同款。
- `/last-sessions`（跨工作区最近 20 会话，带 thread 链接）← `session.list` + `session.search`。
- Kimaki `/model` 无参数时弹交互式选择器——比长参数列表更贴合 Discord；`/model select`
  接入时考虑 button/select 组件而非字符串参数。
- 命令守卫精确化：`/steer` `/stop` 仅在 adapter-owned thread 内有效，否则给「此命令需在
  会话 Thread 中使用」类明确拒绝（Kimaki /abort 的做法）。
- 名字冲突安全：workspace 频道供给的「不抢占、建 -2 兄弟」策略与 Kimaki
  createProjectChannels 的 slug 规则同源。

### Kimaki add-project 源码梳理（commit 3045e1d 已对齐）

Kimaki project↔channel 严格 1:1：
- `add-project.ts` 先 `findChannelsByDirectory`，已有频道回链不建
  （"A channel already exists for this directory: <#id>"）。
- `channel-management.ts createProjectChannels` 创建频道 + `setChannelDirectory`
  是同一原子动作；频道名=basename slug；category=`Kimaki[ <botName>]`。
- `/remove-project` 删频道+映射（目录不动）；autocomplete 排除已有频道的 project、
  按最近排序、value=opaque id（label 含缩写路径——kimaki 泄路径，我们按 disclosure
  策略不泄）。
- **对齐落地**：`planWorkspaceChannel` 增加 `existingForWorkspace`——workspace 已绑
  定的频道无条件复用（一个工作区一个频道），同名复用与 -2 兜底降为后备；确认回复
  区分「已创建（✅ 已为工作区创建频道：<#id>）」与「已存在（该工作区的频道已存在于
 ：<#id>）」两种 Kimaki 文案。当前频道绑定语义不变（design §13 channel-scoped），
  主频道之外的绑定是额外映射。
- **未采纳**：kimaki 在 autocomplete label 与回复中显示目录路径——违反本产品
  disclosure 策略（路径仅管理员 ephemeral）。
  （**已反转**：同日用户裁定路径非敏感面，design §3/spec 已修订为 Kimaki 式路径
  展示；`/project info` 路径对成员可见。）

## 完全 Kimaki 化计划（用户批准方向，2026-08-29）

Phase 0 ✅（commit 5760ac9）：bind=add-project 式主频道供给；general=纯命令面；
list/info 去 ID 化；info 路径对成员可见；specs/design/tasks 16.x 已同步。
**待实测**：`/project bind`（选 tmp）→ 确认 → `#tmp` 建出且回复只提名字；再绑一次 →
「已存在于」；`#general` 不可再被绑定。

- Phase 1（下一步）：会话主链路 — `session.create({workspaceId, sessionId 预分配})`
  → `session.prompt`；源消息建 Thread + thread→session 绑定；Thread 内免 mention 续聊；
  mux 流式渲染（head message + tool 行）；`/stop` `/steer` `/queue` + thread 守卫。
- Phase 2：bindings/intents 落 storageDomain；READY reconcile 扫描。
- Phase 3：approval/question mux 帧交互。
- Phase 4：`/session new/resume`(autocomplete)、`/model`(交互式 select)、`/preset`、
  `/skill run`、`/host status`。
- Phase 5（可选）：`/last-sessions`、上下文用量、图片附件、verbosity。
- 明确不做：3 秒中断重发（用户确认维持 queue+/steer）；voice/定时任务/worktree 远期。
