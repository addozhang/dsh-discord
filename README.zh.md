# @addozhang/dsh-discord

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/@addozhang/dsh-discord)](https://www.npmjs.com/package/@addozhang/dsh-discord)
[![CI](https://img.shields.io/github/actions/workflow/status/addozhang/dsh-discord/ci.yml?branch=main&label=CI)](https://github.com/addozhang/dsh-discord/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@addozhang/dsh-discord)](./LICENSE)
[![node](https://img.shields.io/node/v/@addozhang/dsh-discord)](./package.json)

[DeepSeek Harness](https://github.com/deepseek-ai) 的 Discord 优先适配器：在 Discord 服务器中运行 DSH 会话——@机器人即可开启任务线程、插话与停止运行、在线审批与回答问题，并实时观看回答流式输出。

本插件为 function/namespace 插件（`inject: ['apiProxy', 'credentials', 'settings', 'storageDomain', 'connection']`）：将 Discord Gateway、命令面、流式渲染器与设置卡片挂载到 DSH web profile；会话状态保存在 DSH，适配器的持久绑定保存在 profile 的存储域中。

## 功能

- **@提及驱动会话** — 在已绑定的频道中，被授权的 `@机器人 <任务>` 会锚定一个线程（你的消息成为首帖）、创建 DSH 会话，并且至多提交一次。线程内的后续消息无需 @ 即可排队。
- **流式渲染** — typing 指示、单条头消息编辑、逐工具活动行、代码围栏感知的长文分段、一次性收尾；Turn 结束时活动消息会被删除。
- **审批与提问** — DSH ask 帧渲染为 Discord 按钮、下拉菜单与自由文本弹窗；所有权强制校验（提问者——或后续 Turn 的线程属主——才能点击），超时清扫 fail-closed，远端决议自动退役控件。
- **会话控制** — `/steer`、`/stop`、`/queue list|remove` 带运行所有权校验；`/project bind|list|info` 管理 Guild↔工作区绑定；`/guild forget` 供操作员清理。
- **模型切换** — `/model show` 读取会话的实时模型目录（当前选择、可服务状态、目录分组）；`/model select` 走交互式 provider → 模型 → 推理强度级联（默认对所有授权成员开放，可通过设置收紧为仅 Host 操作员），也可直接填写 `provider/model` 应用。
- **设置卡片** — Token 引导（粘贴 + 连接；存入 Host 凭据服务，绝不写入设置或日志）、连接/断开、服务器白名单、线程自动归档、Bot 语言。
- **双语文案** — 所有 Discord 可见文案提供中英双语；Bot 语言默认跟随 DSH 语言偏好，也可从卡片固定。
- **安全设计** — 显式服务器白名单内的 deny-first 授权、每条 wire 请求携带 `allowed_mentions` 并做字节级提及中和、至多一次的 DSH 提交与保留 unknown 的对账、重启后持久的绑定，以及 READY 扫描：被删的 category/控制频道会重建，被删的工作区频道视为用户意图（解除映射，workspace 保持可重新绑定）。

## 环境要求

- [dsh CLI](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.1.1-rc.2` 或更新（web profile）
- Node.js `^22.19.0 || >=24`
- 一个 Discord 应用（含 Bot 用户），并在开发者门户启用 **MESSAGE CONTENT** 特权 intent（Developer Portal → 你的应用 → Bot → Privileged Gateway Intents）

## 安装

使用 dsh CLI 安装——它会自动把包装进 profile 并注册 bundle：

```sh
dsh plugin --profile web add @addozhang/dsh-discord
```

然后重启 `dsh web` 并刷新浏览器。`dsh plugin` 底层是指向 profile 目录的 pnpm 薄转发；安装完成后它会自动对账 profile 的 `dsh.profile.bundles` 层列表，把所有声明了 `dsh.bundle` patch 的依赖追加进去——无需手动编辑。

升级与卸载使用同一条命令：

```sh
dsh plugin --profile web up @addozhang/dsh-discord   # 升级；bundle 列表会重新对账
dsh plugin --profile web rm @addozhang/dsh-discord   # 卸载；先执行 /guild forget 清理适配器记录
```

如果不用 CLI、手工管理 profile，等价做法是在 profile 目录里用 pnpm 安装本包，并在 `dsh.profile.bundles` 中自行登记：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@addozhang/dsh-discord"] } }
}
```

## 配置

全部配置项位于 `dsh-discord` 设置命名空间，既可以在设置卡片中修改，也可以直接编辑 profile 的用户设置（`settings.yaml`）：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 适配器总开关；卡片 Connect 在 Token 存入后启动。 |
| `allowedGuildIds` | `[]` | 服务器白名单。白名单之外零响应、零 DSH 调用。 |
| `memberUserIds` / `memberRoleIds` | `[]` | 白名单 Guild 内的成员级授权。 |
| `administratorUserIds` / `administratorRoleIds` | `[]` | 工作区管理员级（`/project bind`）。 |
| `deniedUserIds` / `deniedRoleIds` | `[]` | 拒绝名单；优先级高于上述一切授权。 |
| `hostOperatorUserIds` | `[]` | Host 操作员（`/guild forget`；启用 `modelSelectOperatorOnly` 后也包括 `/model select`）。 |
| `modelSelectOperatorOnly` | `false` | 将 `/model select` 限制为 Host 操作员（仅 `settings.yaml`，卡片不展示）。默认 `false`：任何授权成员均可切换，且切换仍会更新 Host 默认。 |
| `defaultVerbosity` | `essential-tools` | 工具活动行粒度：`text-only`、`essential-tools`、`full-tools`。 |
| `language` | `auto` | Bot 可见文案语言：`auto` 跟随 DSH 语言偏好（非中文渲染英文），或固定 `zh`/`en`。 |
| `streamUpdateIntervalMs` | `800` | 流式编辑合并间隔（250–10000）。 |
| `typingIntervalMs` | `7000` | typing 心跳（1000–30000）。 |
| `approvalTimeoutMs` | `600000` | 审批超时（30000–86400000）；超时自动拒绝。 |
| `questionTimeoutMs` | `1800000` | 问题超时（30000–86400000）；超时取消所属 Turn。 |
| `threadAutoArchiveMinutes` | `1440` | 任务线程自动归档：60、1440、4320 或 10080。 |

```yaml
dsh-discord:
  allowedGuildIds: ["1517134847850709032"]
  language: auto
```

设置卡片暴露三个高频项（服务器白名单、自动归档、语言）以及连接与 Token 面；其余键完全支持通过 `settings.yaml` 配置。非法的已存配置会保留最近一次有效配置。

## 初始设置

1. 以至少以下权限把 Bot 邀请到你的服务器：查看频道、**管理频道**（适配器要创建自己的分类和工作区频道）、发送消息、创建公共线程、在线程中发送消息、上传文件、读取消息历史。
2. 启动 profile 并打开 Web 界面。
3. 在 **Settings → Discord** 中粘贴 Bot Token（开发者门户 → 你的应用 → Bot → Reset Token）并点击 **Connect**。Token 由 Host 凭据服务保存——绝不写入设置、日志或客户端。
4. 填写 **允许的服务器**（服务器 ID 获取方式：Discord 开发者模式 → 右键服务器 → 复制服务器 ID）。白名单之外的一切都会被忽略。
5. `/model select` 默认对任何授权成员开放（单人自用部署）。如需限制为 Host 操作员：在 `hostOperatorUserIds` 中加入其用户 ID，并把 `modelSelectOperatorOnly` 设为 `true`（`settings.yaml`）。`/guild forget` 始终需要 Host 操作员。
6. 选择 Bot 语言，然后在已绑定的频道 @机器人 开始会话。

## 命令

| 命令 | 位置 | 说明 |
|---|---|---|
| `/project bind` | 任意频道 | 将 Guild 绑定到工作区（管理员；会创建主频道） |
| `/project list` / `info` | 任意频道 | 列出工作区 / 查看当前频道绑定 |
| `/queue list`, `/queue remove` | 会话线程 | 查看与移除待处理队列 |
| `/steer`, `/stop` | 会话线程 | 插话或取消运行中的 Turn（仅属主） |
| `/model show` / `select` | 会话线程 | 查看实时模型目录；`select` 不带参数时走交互式 provider → 模型 → 推理强度级联（默认对所有授权成员开放） |
| `/guild forget` | 任意频道 | 仅操作员：移除适配器记录 |


## 设计说明

- 设置卡片是首次使用的引导面：Token 输入通过插件管理通道写入凭据服务的 `DSH_DISCORD_BOT_TOKEN` 引用，然后触发启动链。断开连接保留凭据；留空重连直接使用已存 Token。
- 发布工作流通过 npm trusted publishing (OIDC) 认证——任何地方都不保存发布凭证。
- 适配器启动链带代际计数，Connect/Disconnect 与初始启动竞争时只会产生一个 Gateway。
- 凭据探测会回退到 `resolve()`：Host 的 `describe()` 不识别环境变量来源的值——已连接的适配器不会被误报为未配置。
- 适配器日志默认静默：流程记录走 Host 的 debug 级别，失败形态的事件升到 warn——默认级别下不会向 DSH 进程打印任何内容。
- 链路级 trace：启动前设置 `DSH_DISCORD_TRACE=1` 可将 mux 帧、丢弃点与投递结果输出到 stderr（默认静默）。存在原因：rc.2 Host 未为插件日志接线任何 exporter，也没有日志级别开关——`logger.debug` 输出不可见；Host 提供等价机制后应移除。

## 已知限制与推迟项

- **`/session new|resume` 未注册** — 选择器与冷收养模块已实现并通过单元测试，但 Host RPC 面尚不支持（`sessions.list` v1 只返回裸 id；缺少 `session.inspect`）。将在下个里程碑回归。
- **`/preset`、`/skill`、`/host` 保持注销状态** — 控制模块已实现并通过单元测试，待路由接线时回归（`/preset` 的会话线程守卫一并处理）。
- **verbosity 为全局设置**（DSH 生态有按频道设置的先例）。
- **经 Kimaki 对齐后有意推迟**：reconcile-interactions 接线、ask 等待期暂停 typing、fail-closed 绑定/会话属主 store 接线、凭据轮换监听。
- **已知张力**：流式编辑 250ms 下限与高负载下 Discord 编辑预算的冲突（429 自愈），以及 typing 缺少时长上限看门狗。

## 开发

```sh
pnpm install --ignore-scripts
pnpm test          # 650 tests incl. gateway/REST twin E2E
pnpm typecheck
pnpm lint
pnpm build         # lib + client bundle
```

在 profile 中试用本地构建：

```sh
pnpm pack --pack-destination /tmp
dsh plugin --profile <your-profile> add file:/tmp/addozhang-dsh-discord-<version>.tgz
```

`dsh plugin` 会把相对路径锚定到调用目录，因此在已执行 `pnpm build` 的仓库里也可以直接 `dsh plugin --profile <your-profile> add ../fiber`。重复 pack + add 即可刷新已安装副本，然后重启 `dsh web`。

发布由 [GitHub Actions](./.github/workflows/publish.yml) 经 npm trusted publishing (OIDC) 完成（`npm version <level> && git push --follow-tags`）——任何地方都不保存发布凭证。实现遵循 `openspec/changes/build-discord-native-adapter/` 中的 OpenSpec 变更（设计、能力 spec、验证清单、评审报告）。

## 许可证

MIT
