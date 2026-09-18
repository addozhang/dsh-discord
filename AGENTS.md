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

联调部署（本地构建装进 profile）：

```sh
pnpm pack --pack-destination /tmp
dsh plugin --profile web rm @addozhang/dsh-discord     # 必须先 rm
dsh plugin --profile web add file:/tmp/addozhang-dsh-discord-<ver>.tgz
# 重启 dsh web 后生效；装完 diff 校验安装副本 == tarball（见"已知陷阱"）
```

联调观测：`DSH_DISCORD_TRACE=1 dsh web --no-open` 启动，stderr 输出 mux 帧、
丢弃点与投递结果（默认静默）。

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

## 0.1.6 Host 面的事实（2026-09-18 真机核实，dsh 0.1.6-alpha.1）

- 宿主接入面 = 三个 cordis 服务（`dsh-host-apiproxy`/`ctx.apiProxy` 已删除）：
  `sessionController`（prompt/create/list/cancel/updateQueue/selectModel/
  modelCatalog/follow/control）、`workspaceController`（create/rename/
  archiveSession/unarchiveSession/insertBefore/**follow**——无 baseline 一元方法，
  基线是 follow 流首帧 `{type:'baseline', value:{items, archivedSessionIds}}`，
  本仓库 face 的 `readWorkspaceBaseline` 取首帧即断订）、`sessionQuery`
  （`observeSession` → `projections.values.modelSelection` = `{lastUsed, next}`
  视图，/model 的 current 来源）
- 控制器是**直调**面：plain request 进、plain value 出、业务拒绝是**抛**
  `RemoteError`（`{code, message}`）；`session/` 前缀在 face 层翻译回旧词汇
  （`session/agent-busy`→`agent-busy`），Discord 文案零变化
- `session.prompt` 的 `requestId` **必填**（客户端铸造，宿主按其幂等去重）——
  正好落在本仓库既有 rpcId 纪律上；content parts 仍是 text/image（新增
  file+receiptId 路径未用）
- `session.models` 没了：全局无参 `modelCatalog()`（`{default,
  routableProviders, groups, failures}`）+ 按会话 modelSelection projection
  组装；`routable:boolean` 由 `routableProviders.includes(current.provider)`
  推导
- **服务方法签名逐个核对过（2026-09-18 真机）**：`prompt(request, signal)`
  signal **必填**（裸 `throwIfAborted`，缺参直接 TypeError→我们的 unknown 路径）；
  `list(signal)` 与 `control(signal)` 只收 signal（传 `{}` 会把对象当 signal 炸）；
  `create/attachment/updateQueue/cancel/selectModel(request)` 与
  `modelCatalog()` 无 signal；`follow(request, signal)` 双参。规则：**signal
  恒为最后一个参数，且各方法要不要/要不要不了——必须逐个实测**
- 事件流 = `sessionController.follow({address}, signal)` 按会话 journal 帧，
  **records 是双层信封**：`{type:'event'|'snapshot', records:[{type:'event',
  event:{type,seq,time,data}}]}`——真正的事件在 `event` 键下（2026-09-18 真机
  dump 抓到的形状；face 层已防御性兼容扁平形状）。**snapshot 开窗必须翻译**：
  turn 常在 prompt 准入与 follow 订阅之间完成，快照是那些记录的唯一载体；
  按会话 seq 水位去重保证重订阅幂等（`replayHistory` 追赶路径从未接线，
  事实上不存在）+
  `sessionController.control(signal)` 宿主级队列/投影帧；
  `src/dsh/host-events.ts` 扇入为旧 LiveFrame 词汇，渲染层零改动
- 审批/提问：waterfall 对**外部插件不可达**（2026-09-18 真机穷尽验证）：profile
  按 bundle 组装多棵事件树，ask waterfall 只枚举基座树自己的注册表——外部插件
  的 `ctx.on`、`{global:true}`、根 events 服务、甚至挂在 approval 服务 ctx 上的
  桥接插件**全都收不到**（只有基座树内的 api-remotes 等收得到）。**受支持做法 =
  服务边界补丁**：包一层 `ApprovalService.request` / `UserQuestionService.ask`
  （`installAskServicePatches`）：线程绑定的会话走 Discord 按钮流（askWiring 渲染
  → 点击 → settle port → 返回 outcome），其余原样透传（web UI 面板不受影响）。
  真机已验证全链路：claimed → 按钮 → 浏览器点击 → allowed-once → 工具执行落地。
  `client-response` 信封与 respond RPC 已死；注意补丁路径不写 approval/asked
  审计事件对（journal 少这对审计，工具侧语义完整）
- 图片 modality 门语义不变（`inputModalities`/`MODEL_DOES_NOT_SUPPORT_IMAGES`
  /`DEFAULT_INPUT=["text"]`），错误码改为
  `RemoteError('session/attachment-invalid')`；settings.yaml 加
  `input: [text, image]` 的解锁方式依旧有效
- `session.selectModel` 宿主现在会尝试持久化默认（失败仅 warn）——
  "不得声称持久化成功"的文案限制可放松
- `session.list` 行仍无 archived 标记（归档集只在 workspace 基线）；
  `session.list` 响应仍是 `{items}`，行不再有 `agentPreset`
- **`ctx.connection.rpc.handle` 对外部插件不可用**（0.1.6 真机三连踩）：
  它把路由挂到 connection 服务**自己的 ctx** 上，外部调用抛
  "cannot get property webServer without inject"；包一层 runtime
  `ctx.inject` 也不行——**已启动插件的 runtime inject 回调永不执行**
  （静默 no-op，通道 405）。受支持做法 = 自己注册：
  `ctx.effect(() => ctx.get('webServer').register({kind:'prefix', path,
  handler}))` + 复用 `connection.requestRejection(req)` 围栏 + 手工复刻
  channel 信封协议（见 `installAdapterStatusRpc`；endpoint 段模式
  `/^[A-Za-z0-9_$.-]+$/`，方法必须等于 endpoint）
- **启动 profile 必须带 `--profile` 标志**：`cd <profile dir> && dsh web`
  启动的是**默认 profile** 而非 cwd 的——2026-09-18 排查 405 时被此误导
  两个回合（web-test 目录里跑的一直是 web）
- **tool view 策划已从 wire 上消失**：durable 事件无 view 字段，assistant-stream
  帧只载 LLM 文本增量；Discord 渲染器本地推导（shell 家族取 arguments.command
  首行经 safeTitle 消毒——`shellCommandTitle`；其余工具退到 allowlist 标签）
- Discord autocomplete choice 无 description 字段等 Discord wire 事实不变
- Gateway 断连在 stderr 可见：`[dsh-discord] gateway close: N`（1006=链路
  异常断开，4000=会话失效强制 re-identify）；重连 + READY reconcile 自愈，
  断连窗口内 autocomplete 报 "Loading options failed" 属预期
- 控制频道拒绝、候选 workspace 作用域等行为的判据见
  `session-resume.ts` 与 `index.ts` 的 resumeSession

## 测试与联调约定

- 纪律：行为变更先写失败测试（RED→GREEN）；wire 形状走 twin E2E，
  纯逻辑走模块单测
- twin（discord-digital-twin）**不建模 Discord 表单校验**——nonce 长度这类
  wire 约束 twin 测不出来；wire 契约改动必须真机验证一次
- twin 的 `waitForMessage` 扫频道全量历史：测试谓词必须跨用例唯一，
  否则会匹配到早前用例的消息
- 失败路径的日志必须可观测：失败形态事件升 warn（默认级别可见）

## 已知陷阱（本仓库真实发生过）

- `dsh plugin add` 对同名 tarball 可能是空操作（pnpm "added 0"）——
  重装必须先 `rm` 再 `add`，并 diff 校验安装副本
- compose 后 `lib/` 与源码可能不同步：`pnpm pack` 前必须 `pnpm build`
- `exactOptionalPropertyTypes` 开启：可选属性不能显式赋 `undefined`
- eslint：async 函数无 await（桩函数用 `() => Promise.resolve(...)`）、
  `no-unnecessary-condition` 对窄化后的联合类型敏感
- 部署目标是 `~/.dsh/profiles/web`；`~/.dsh/settings.yaml` 的 `dsh-discord`
  段是用户设置；凭据在 `~/.dsh/.credentials.yaml`（勿打印）
- 卸载/排障后清理一次性 profile；`/tmp` 的 tarball 是部署中间产物

## OpenSpec 工作流

- 行为变更 = `tasks.md` 加编号条目（16.x，含决策人与理由）+ `design.md`
  对应章节 + `specs/<capability>/spec.md` 同步；`openspec/` 不入库（本地）
- 提交遵循 conventional commits；发布 = `npm version <level> &&
  git push --follow-tags`，GitHub Actions 自动 npm publish
- README.md / README.zh.md 双语同步；命令表、已知限制随命令面变化更新
