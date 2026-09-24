# AGENTS.md

面向编码代理的项目指引。人读的文档在 `README.md` / `README.zh.md`；本文件只记录
agent 容易做错的事、项目纪律与不写代码就查不到的事实。改动约定时同步更新本文件。

## 项目

DeepSeek Harness（DSH）的 Discord 原生适配器：function/namespace 插件，挂载
Discord Gateway、命令面、流式渲染器与设置卡片到 DSH web profile。TypeScript +
pnpm + vitest；发布走 GitHub Actions（npm OIDC trusted publishing，无发布凭证）。

## 常用命令

```sh
pnpm install --ignore-scripts
pnpm test              # vitest 全量（含 gateway/REST twin E2E）
pnpm typecheck         # tsc --noEmit（exactOptionalPropertyTypes 开启）
pnpm lint              # eslint --max-warnings 0
pnpm build             # lib + client bundle（client 有独立打包步骤，勿跳）
pnpm pack --pack-destination /tmp
```

联调部署（本地构建装进 profile）。**宿主运行期间持有 profile 的
`package.json.lock`（flock），插件 rm/add 会撞锁——必须先停宿主**：

```sh
pnpm build && pnpm pack --pack-destination /tmp
dsh plugin --profile web rm @addozhang/dsh-discord     # 必须先 rm
dsh plugin --profile web add file:/tmp/addozhang-dsh-discord-<ver>.tgz
# 重启宿主后生效；装完 diff 校验安装副本 == tarball
```

联调观测：`DSH_DISCORD_TRACE=1` 启动，stderr 输出 mux 帧、丢弃点与投递结果
（默认静默）。启动形态：`dsh --profile <name> --no-open --port <n>`——
`dsh web` 里的 `web` 是 **profile 名简写**，`--profile` 给值后不能再跟 app 名。

## 架构地图

- `src/index.ts` — 组合根：全部端口接线、READY reconcile、命令注册、settings 应用
- `src/compose.ts` — 运行时（gateway → ingress → 路由 → 投递 → READY 钩子）
- `src/features/*` — 一个关注点一个模块（审批/提问/绑定/模型/恢复/对账……）
- `src/discord/*` — Discord wire 层（REST 客户端、命令注册、控件、投递队列）
- `src/stream/*` — 事件 → 每线程渲染（head 消息、活动行、typing、finalize）
- `src/client/*` — 浏览器设置卡片（独立 bundle，`pnpm build` 含其打包）
- `src/i18n.ts` — Discord 可见文案，zh 定义 `CopyTable` 类型，en 必须同步
- `src/policy/*` — 授权与披露策略
- 状态只走 storageDomain 三表：`channel_bindings` / `thread_bindings` / `inbound_intents`

## 不变量（改动前先读）

- **at-most-once 投递**：`unknown` 结果可能已送达，绝不盲目重发——nonce 对账；
  nonce 是 Discord wire 字段，**≤ 25 字符**（36 位 UUID 会 50035，用 `newNonce()`）
- **只注册已路由的命令**：注册集里不允许出现没有路由分支的死命令
- **默认静默日志**：流程事件走 Host logger 的 debug，失败形态（…failed/…threw/
  …blocked/…unknown）升 warn；wire 级排错用 `DSH_DISCORD_TRACE=1`
- **deny-first 授权**：guild 白名单是外层边界；级别 member < workspace-admin <
  host-operator；模型切换默认限 Host 操作员（`modelSelectOperatorOnly` 可放开）
- **双语**：所有 Discord 可见文案 zh/en 双份；卡片 locale 键在
  `slot-contract.ts`（类型）+ `client/index.ts`（字典）+ 渲染引用，三处同步
- **opaque custom_id**：DSH 标识符（session/approval id 等）不上 Discord wire，
  组件 id 走 registry 不透明键
- **绑定即所有权**：thread/channel 绑定是 Discord 占用的权威记录；已占用会话
  不再收养，被删除的绑定频道按用户意图 retire 映射
- **控制频道（类目下 general）**不承载会话，也不参与 /session resume

## Host 面事实（0.1.7 线；2026-09-24 rc.1 双矩阵真机核实）

### 服务与调用面

- 宿主接入面 = 三个 cordis 服务：`sessionController`（prompt/create/list/cancel/
  updateQueue/selectModel/modelCatalog/follow/control/resolveAgent）、
  `workspaceController`（create/rename/archiveSession/unarchiveSession/insertBefore/
  follow——**基线 = follow 流首帧** `{type:'baseline', value:{…}}`；`baseline()`
  一元方法存在但是 WorkspaceFeed 内部方法、非 @Remote）、`sessionQuery`
  （`observeSession` → `projections.values.modelSelection` = `{lastUsed, next}`，
  /model 的 current 来源）
- 控制器是**直调**面：plain request 进、plain value 出、业务拒绝是**抛**
  `RemoteError`（`{code, message}`）；`session/` 前缀在 face 层翻译回旧词汇
- `session.prompt` 的 `requestId` **必填**（客户端铸造，宿主按其幂等去重）；
  content parts 仍是 text/image
- 模型目录 = 全局无参 `modelCatalog()`（`{default, routableProviders, groups,
  failures}`）+ 按会话 modelSelection projection 组装；`routable` 由
  `routableProviders.includes(current.provider)` 推导
- **服务方法签名（逐个真机核实，不许凭类型推导）**：`prompt(request, signal)`
  signal 必填；`list(signal)` / `control(signal)` 只收 signal（传 `{}` 会炸）；
  `create/updateQueue/cancel/selectModel(request)` 与 `modelCatalog()` 无 signal；
  `follow(request, signal)` 双参。规则：signal 恒为最后一个参数
- `session.list` 行无 archived 标记（归档集只在 workspace 基线）；响应是
  `{items}`，行无 `agentPreset`
- **`ctx.connection.rpc.handle` 对外部插件不可用**（路由挂 connection 服务自己的
  ctx，外部调用抛 inject 错误；runtime `ctx.inject` 对已启动插件是静默 no-op）。
  受支持做法 = 自己注册：`ctx.effect(() => ctx.get('webServer').register(
  {kind:'prefix', path, handler}))` + `connection.requestRejection(req)` 围栏 +
  手工复刻 channel 信封协议（见 `installAdapterStatusRpc`；endpoint 段模式
  `/^[A-Za-z0-9_$.-]+$/`，方法必须等于 endpoint）

### 事件流与渲染围栏

- 事件流 = `sessionController.follow({address}, signal)`，**必须带
  `assistantStream: true`**——不带时宿主只推开窗快照、live tail 永不推送。
  两种载体都要认：快照开窗 `{type:'snapshot', records:[{type:'event',
  event:{…}}]}`（双层信封）与 live 单记录 `{type:'event', event:{…}}`
  （host-events.ts 的 batch 归一）
- **snapshot 开窗必须翻译**：turn 常在 prompt 准入与 follow 订阅之间完成；
  按会话 seq 水位去重保证重订阅幂等
- **渲染水位围栏**：thread binding 持久化 `renderedSeq`，`track()` 播种 floor、
  渲染层在 turn/end 回写；无水位的旧 binding 首快照整体抑制。重启/reconnect 后
  零重放 + 错过后缀精确补投（真机多次验证）；回写偶发 `stale-revision` 跳过会
  自愈；崩溃窗口内 ≤1 turn 的有限重复成文接受（宁重复不丢消息）
- **user/message 回显**（catch-up/live，`source.kind==='user'` 过滤；`discord:`
  rpcId 仅新 runtime 首窗回显，plugin 注入永不渲染）——回显的是消息**原文**，
  含密内容（如 token）会泄漏进线程；脱敏规则待做
- assistant-stream 帧词汇：`{type:'start'|'chunk'|'end', attemptId, revision,
  index, …}`；chunk 子型 block-start/block-end/text-delta/tool-call-delta/
  finish/usage。工具调用在 durable `tool/call` 之前就开始流式下发
- `tool/result` 失败标志 = `message.content[0].isError === true`（无顶层 error 键）
- tool view 策划已从 wire 消失：渲染器本地推导（shell 家族取 arguments.command
  首行经 `shellCommandTitle` 消毒；其余工具退到 allowlist 标签）
- Gateway 断连 stderr 可见：`[dsh-discord] gateway close: N`（1006=链路异常，
  4000=会话失效强制 re-identify）；重连 + READY reconcile 自愈，断连窗口内
  autocomplete 报 "Loading options failed" 属预期

### 审批 / 提问 / 权限

- ask waterfall 对**外部插件不可达**（profile 按 bundle 组多棵事件树，只枚举基座
  树注册表）。受支持做法 = **服务边界补丁**：包一层 `ApprovalService.request` /
  `UserQuestionService.ask`（`installAskServicePatches`）——线程绑定会话走 Discord
  按钮流，其余透传（web UI 不受影响）。补丁路径不写 approval/asked 审计对
- 权限预设三档 `read-only` / `workspace-write` / `danger-full-access`（沙箱+审批
  捆绑）。读 = `permissionPresets.catalog()` + `observeSession` 的 permissions
  投影 `{currentValue}`；写 = 宿主唯一认可的 `/permission` 命令路径：
  `resolveAgent(sessionId)` → `{agent}`（opaque）→ `commands.execute(agent,
  '/permission <name>', [], signal)`；命令生命周期自动记 `command/run` +
  `command/done` 审计对，切换产生 durable `permission/preset` 事件（渲染层出系统行）
- 图片 modality 门：`inputModalities` / `MODEL_DOES_NOT_SUPPORT_IMAGES` /
  `RemoteError('session/attachment-invalid')`；settings.yaml `input: [text, image]`
  解锁方式有效

### settings / Config 模型（0.1.7 profile-backed forms）

- 注册模型 = 插件静态 `Config` schema（`meta.volatile` 字段是免重挂载表单项）；
  `installSection` / `.get(ns)` 已删除；`settings.yaml` 首启自动导入 profile
  文档并改名 `.imported`；`settingsController` remote（describe/update/replace，
  redactSecrets 视图）可用
- 客户端：`ctx.configForms.get<T>(ns)`（`settingsScope` 已删）；`ConfigForm` 与旧
  SettingsScope 协议同构（getSnapshot/subscribe/set/unset）
- volatile 语义：schemastery `.volatile()` 字段以 `Volatile<T>` 到达 apply 的
  config（`.get()` 取不可变快照）；宿主原地推送、纤维零重挂载；ns =
  cordis.patch.yml 行 `id`（我们 = `dsh-discord`）；通知 =
  `settings/document-updated` (ns, revision)（boot 全 ns 洪泛，按 ns 过滤）；
  locale 读 = `settings.describe()` 找 `ns==='locale'` 的 `value.preference`；
  volatile mode 使字段 default 类型变 `Volatile<T>`——schema 常量不能标
  `z<DiscordSettings>` 注解
- **判例：宿主内部包（settings/config-editor/app-boot 等）绝不进插件
  dependencies**（会装出双副本破坏宿主单例假设）；仅 type-import 的放
  devDependencies；真运行时依赖（dsh-credentials、dsh-storage-domain）可保留

### 全局态与多 profile（2026-09-24 实测）

- `~/.dsh/sessions`（journal）、`~/.dsh/storages/dsh_discord.json`（三表）、
  `~/.dsh/.credentials.yaml`（凭据**全局单槽**）跨 profile 共享——profile 只隔离
  插件树与配置
- 同机双宿主 + 同 bot token = **gateway 互踢**（后连者顶掉前者）；三表并发写有
  竞争风险。**单宿主假设**：起验证实例前先确认其它宿主没有 Discord 插件在跑
- 无效 token 的失败相位：REST 阶段（命令注册）失败时卡片只显示无 hint 的
  disconnected——invalid-token 判定依赖 gateway close 4004（UX 缺口）
- rc.1 宿主有**插件精确版本兼容门**：插件 peerDeps 钉 dsh 内部包版本不匹配即
  禁用 row（官方 alpha 插件在 rc.1 宿主被禁）；本插件无 dsh 内部包 peer，
  天然免疫；dependencies 自带副本的矩阵继续成立
- storage-domain 0.1.7-rc.1+ 依赖 schemastery `~3.18.4`——插件 pin 必须对齐
  （.pnpm 出现两实例 → 声明发射 TS2742）

**验证基线**：2026-09-24 dsh 0.1.7-rc.1——混合矩阵（alpha.1-pin 插件 + rc.1 宿主）
与同版矩阵（rc.1-pin）双真机通过（卡片/状态 RPC/命令注册与执行/permission 双向
沙盒切换/ephemeral/流式渲染/零重放/错过后缀补投）；审计 49 OK + 2 已知 CHANGED
（installSection 时代标记、baseline() 内部方法）零漂移。

## 测试与联调约定

- 纪律：行为变更先写失败测试（RED→GREEN）；wire 形状走 twin E2E，
  纯逻辑走模块单测
- twin（discord-digital-twin）**不建模 Discord 表单校验**——nonce 长度这类
  wire 约束 twin 测不出来；wire 契约改动必须真机验证一次
- twin 的 `waitForMessage` 扫频道全量历史：测试谓词必须跨用例唯一
- 失败路径的日志必须可观测：失败形态事件升 warn（默认级别可见）

CDP 驱动真机（rc 级验证要求）：

- Chrome 带 `--remote-debugging-port=9222`；CDP 键盘事件需要页面焦点
  （`Emulation.setFocusEmulationEnabled` + `Page.bringToFront`）；`Input.insertText`
  能插入文本但 Discord 斜杠命令检测需逐键 keyDown；命令菜单的过滤与分组标签
  （dsh 分组）可点击
- 不要用 DOM API 清空 Slate 编辑器（内部模型脱同步，后续行为诡异）——整页
  reload 重置
- Discord 消息列表虚拟化：视口不在直播沿时新消息不进 DOM，读尾部前先滚到底
- REST 可替代部分 UI 验证：guild commands 列表、频道消息尾读（带 bot token）

## 已知陷阱（本仓库真实发生过）

- `dsh plugin add` 对同名 tarball 可能是空操作（pnpm "added 0"）——重装必须先
  `rm` 再 `add`，并 diff 校验安装副本
- `dsh plugin add pkg@dist-tag` 可能解析到过期缓存版本——发版后一律用**精确
  版本号**安装，装完核对 node_modules 里的 version 字段
- compose 后 `lib/` 与源码可能不同步：`pnpm pack` 前必须 `pnpm build`
- `exactOptionalPropertyTypes` 开启：可选属性不能显式赋 `undefined`
- eslint：async 函数无 await（桩函数用 `() => Promise.resolve(...)`）、
  `no-unnecessary-condition` 对窄化后的联合类型敏感
- 冒烟 profile 运维：pnpm 11 `allowBuilds` 门会拦 `koffi`（profile 的
  pnpm-workspace.yaml 设 `koffi: true`）；中断的 add 留 `package.json.lock`
  僵尸（删锁重试；重跑 add 不补登记 bundle 列表，按 README 手动登记）；
  `@deepseek-ai/dsh-web-app` npm `latest` 是死版本——精确版本号安装
- 部署目标是 `~/.dsh/profiles/web`；凭据在 `~/.dsh/.credentials.yaml`
  （全局单槽，勿打印）；一次性 profile 用完清理

## dsh 官方版本升级 playbook

### 检测（每次 dsh 发版后 30 秒）

```sh
npm view @deepseek-ai/dsh dist-tags --json       # 看 alpha/next/latest 哪个动了
scripts/host-surface-audit.sh                     # 审计 alpha（默认）
scripts/host-surface-audit.sh --latest            # 审计 stable
```

脚本输出三色报告（✓ OK / ⚠ CHANGED / ✗ MISSING）；exit 0 = 不用动，exit 1 = 需要跟进。

### 分级响应

| dsh 通道 | 动作 | 发布 |
|---|---|---|
| alpha | 跑审计脚本 + 本地装 profile 冒烟 | 不发布；破坏点记 AGENTS.md |
| rc/next | 审计 + 全功能真机验证（CDP 驱动 Discord） | 发对应 `-rc.N`（CI 自动 `--tag next`） |
| latest（stable） | 全量验证 | 发正式版，依赖去 alpha 钉 stable |

### 已固化的规则（0.1.6 迁移踩出来的）

- **宿主接触面只允许出现在 3 个文件**：`host-face.ts`（RPC）、`host-events.ts`（事件）、
  `host-asks.ts`（审批/提问）——新增接触点必须同步 startup.ts 契约探针
- **方法签名不许凭类型推导**：signal 位置/必填性/返回形状逐个真机核实后记入上方事实表
- **任何 `ctx.on` / `ctx.inject` 的运行时行为先探针后编码**（runtime inject 对已启动
  插件是静默 no-op；作用域 waterfall 对外部插件不可达）
- **不在 alpha 通道上发 `latest`**（CI 已固化 dist-tag 映射：alpha→alpha、beta→beta、
  rc→next）

### 接触面清单（审计脚本覆盖的全部）

10 inject 服务（+commands、permissionPresets）+ 10 sessionController 方法
（+resolveAgent）+ 6 workspaceController 方法 +
2 ask 服务入口 + 5 项权限面检查 + 4 settings 面检查（+2 已删符号确认未复活）+
4 client 类型包（+2 已死包确认未复活）+ 双层事件信封与 snapshot 帧 = **49 项检查**
（rc.1 基线全绿；installSection 检查语义已随 Config 迁移完成翻转——缺席=正确，
回归出现才告警；baseline() 内部一元存在与否均 OK，仅记录形态）

## OpenSpec 工作流

- 行为变更 = `tasks.md` 加编号条目（16.x，含决策人与理由）+ `design.md`
  对应章节 + `specs/<capability>/spec.md` 同步；`openspec/` 不入库（本地）
- 提交遵循 conventional commits；发布 = `npm version <level> &&
  git push --follow-tags`，GitHub Actions 自动 npm publish
- README.md / README.zh.md 双语同步；命令表、已知限制随命令面变化更新
