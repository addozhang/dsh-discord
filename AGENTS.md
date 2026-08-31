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

## rc.2 Host RPC 面的事实（2026-08 核对）

- `sessions.list` 行含 `updatedAt`（倒序）/`running`/`blank`/`cwd`/
  `origin`（"subagent"）/`projections.values.title`（缺省 = 尚无标题）；
  **无** `session.inspect`、history RPC、archived 字段（行不标记归档）
- `workspace.list` 值含每行 `path`（realpath 规范化，如 /tmp→/private/tmp）
  与 registry 级 `archivedSessionIds`——**归档信息只在这里**；归档会话可被
  恢复/adopt 但永远不运行 turn（表现：线程里发消息无任何响应）
- `workspace.archiveSession` 不影响 `sessions.list` 可见性（归档后仍在列表）
- Discord autocomplete 的 choice 对象**没有 description 字段**（仅
  name/localizations/value）——候选可见信息必须进 label，且 name ≤100 字符，
  超限整个回答被拒
- Gateway 断连在 stderr 可见：`[dsh-discord] gateway close: N`（1006=链路
  异常断开，4000=会话失效强制 re-identify）；重连 + READY reconcile 自愈，
  断连窗口内 autocomplete 报 "Loading options failed" 属预期
- `session.selectModel` 只证明 Session 切换；Host 默认的持久化结果不回传，
  文案不得声称持久化成功
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
