# Code Review: build-discord-native-adapter

- 日期: 2026-08-28
- 范围: 全部 19 个提交（05ceaa3..0b16cec），src 7,310 行 + test 8,436 行
- 裁决: **Request changes** — 1 Critical + 6 Required；模块层质量高，但产品未组装完成

---

## Critical

### C1. 生产组合层不存在——插件装上后什么都不做

`src/index.ts:34` 的 `apply()` 只装配三样东西：启动校验、settings、adapter-status RPC + 凭据 describe。全 src 范围 grep 证实：

- `startGateway`（src/gateway/gateway.ts:76）无任何生产调用方，仅 test/gateway.test.ts 使用
- `createRestClient`（src/discord/rest.ts:78）、`createAuthorizedIngress`（src/policy/guard.ts:27）、`createComponentRegistry`、全部 feature 流、reconciliation sweep——同样只有测试在调
- package.json `main: ./lib/index.js` + cordis.patch.yml 挂载的就是这个 apply

效果：插件激活 = 一张设置卡。Gateway 不连、命令不注册、消息不分发、15 个 section 的功能全部不可达。`src/index.ts:47-48` 注释自己承认 "the Gateway observation fed by the adapter composition as it starts (15.x)"——该组合从未写成。

15.8 的 "502 tests green" 是模块级绿灯，掩盖了未接线；15.10 手动 E2E 未做所以从未暴露。这正是 15.9/15.10 人工验证步骤要抓的东西。**编写组合层（composition root）是合并前唯一阻断项。**

## Required

### R1. 组件 ID 默认工厂可预测

src/discord/components.ts:42-45 用 `Date.now().toString(36)-counter`。审批/提问的 custom_id 可被枚举猜测。所有权校验（src/features/approval-store.ts:181）兜底使其不直接成洞，但 design §116 的"不透明"承诺依赖调用方注入安全 idFactory——而组合层缺失，现状会以可预测 id 上线。默认改 `crypto.randomUUID()`。

### R2. Markdown 围栏感知分割未接线

`splitMarkdownAware`/`closeOpenFences`（src/stream/markdown.ts:14,60）在 src 无调用方；src/stream/finalizer.ts:44 用的是围栏盲的 `splitMessage`。任务 11.6 声称完成的是模块+隔离测试；实际最终答案长文会从 ``` 代码块中间劈开产生跨消息破损渲染。finalizer 改用 `splitMarkdownAware`。

### R3. `liveSeen` 参数死亡

src/features/reconcile-events.ts:47 声明 `liveSeen`，函数体从未引用；docblock（第 5 行）声称 "skips events whose live delivery is already known"，实际全靠 `deliver()` 返回 `'duplicate'`。删参数或实现，二选一。

### R4. conflict 语义被吞

src/features/image-submission.ts:74 把 `conflict`（同 request ID 不同内容）映射为 `already-submitted`，与 src/features/prompt-submission.ts:53 的独立 `conflict` 分流不一致。内容分歧的投递被静默报"已提交"。对齐 prompt-submission。

### R5. 有界内存声明与实现不符

src/features/image-collection.ts docblock（第 2-7 行）称 "bytes are counted against the caps as they arrive... structurally impossible"，实际 body 是整块 `Uint8Array` 收完才查（:51-58）；单图峰值内存 = 端点给的整个 body。CDN 专列 allowlist 缓解了实际风险，但虚假不变量必须消除：换流式计数 port 或改 docblock。

### R6. fail-closed store 的读路径不设防

src/state/fail-closed.ts:64-76 只在 bind/release 前置 `guard()`；`get`（:65）直通 inner。malformed/newer record 会以"已验证的 V 类型"流入业务读路径（src/state/channel-bindings.ts:44,66 的 resolve/listForGuild）。写路径达标，读路径至少要校验 + corrupt 时返回可诊断状态。

## Nit / Optional

- **N1** 每-key promise chain Map 永不清理（src/state/bindings.ts:41、src/state/intents.ts:70、src/features/approval-store.ts:80、src/features/question-store.ts:184）——长生命周期后遗留 settled promise，量级小
- **N2** src/gateway/gateway.ts:156 重_HELLO 会覆盖泄漏旧 heartbeat interval；:116 `onopen` 空函数体
- **N3** src/discord/rest.ts:55、src/stream/finalizer.ts:60 的裸 `setTimeout` 不挂取消根——dispose 后重试链最多再跑 ~90s（有界，组合时用 AbortSignal 贯穿即可）
- **N4** src/stream/splitter.ts:46-48 硬切 + 代理对拉回时 `rest.slice(limit)` 丢弃代理对前半，下一 chunk 开头留 dangling low surrogate（极端边界）
- **N5** src/state/intents.ts:102-108 `resolve` 无迁移校验，src/features/thread-creation.ts:65,83 有意用 failed→succeeded 重写；src/state/intents.ts docblock（第 7 行）"never silently rewritten" 措辞过强
- **N6** src/index.ts:52-54 credential describe 失败静默降级 `configured:false`，无日志
- **N7** src/index.ts:30-33 docblock "runtime effects are added by subsequent OpenSpec tasks" 已过时——且正是 C1 的现场标记
- **N8** src/gateway/ingress.ts:54 `createIngressGate` 与 src/policy/guard.ts:27 `createAuthorizedIngress` 功能重叠，前者生产无调用方，删一个

## 分轴评价

| 轴 | 评价 |
|---|---|
| Correctness | 模块级语义严谨：generation 围栏、revision fence、claim→submit→settle 原子链、first-resolution-wins、watermark 先记账后提交（src/features/reconcile-events.ts:84-88）全部经代码核实成立；缺口全在集成缝隙 |
| Security | deny-first 授权、authorization-before-effect（guard 单一入口）、token 零落盘（扫描干净：无硬编码凭据、无 Discord token 形态串）、CDN exact-host + 单跳重验证、mention 双重抑制（flag + 字节级破坏）、approval/question 所有权"管理员也拒"——在模块层成立 |
| Architecture | 纯域逻辑 + 端口注入 + 值化错误，测试性优秀；扣分项：双门禁冗余（N8）、组合根缺席（C1） |
| Readability | docblock 密度恰当且解释"为什么"；但三处 docblock 声明强于实现（R3/R5/N5），文档失真比代码丑更危险 |
| Performance | REST 429 有界（cap 30s）、per-route 串行、渲染单飞合并；无 N+1 面 |

## 覆盖声明

逐行读过：policy×4、state×9、gateway×3、discord×6、stream×9、approval/question×8、image×3、reconcile×3、settings/credential/lifecycle/startup/index、turn-ownership、thread-routing、thread-creation、prompt-submission、card-form。约 20 个会话流小文件（session-adopt/resume/creation、controls、views、commands、selector、typing 等）经 checkpoint-c 集成测试与抽样覆盖，未逐行读。未重跑测试套件（15.8 记录为 502 green，本评审以代码事实为准）。密钥全库扫描 clean；无 TODO/FIXME/`any`。

---

## 处置记录（2026-08-28，commit 0924a6c）

- **C1 已修复**：新增 `src/compose.ts` 组合根 + `test/compose.test.ts`（4 tests）。Gateway→授权入口→路由→apiProxy prompt 适配→状态跟踪→一键 dispose 全部接线；`src/index.ts apply()` 现在实际启动运行时。集成测试证明：授权提及→DSH prompt 提交、未授权/未绑定→零调用、缺 token→fail-closed 离线、dispose→Gateway 关闭。
- **R1 已修复**：默认 idFactory 改 `crypto.randomUUID()`。
- **R2 已修复**：finalizer 改用 `splitMarkdownAware`，长文不再劈开代码块。
- **R3 已修复**：`liveSeen` 真正生效——命中事件跳过投递但推进水位。
- **R4 已修复**：image-submission 独立 `conflict` 分支，与 prompt-submission 对齐。
- **R5 已修复**：docblock 改为如实描述（单图峰值=整个 body，受 CDN 限制+聚合上限约束）。
- **R6 已修复**：fail-closed `get` 读路径校验，corrupt 键返回 undefined（诊断走 `diagnose`）。
- **N2/N4/N5/N6/N7/N8 已修复**：心跳定时器重 HELLO 前清理、代理对边界 rest 推进量同步、intents 措辞精确化、credential 探测失败记日志、过时 docblock 移除、冗余 `createIngressGate` 删除（测试移植到 authorized 入口）。
- **N1/N3 有意保留**：per-key chain Map 残留量级小且生命周期内单调有限；`setTimeout` 重试链将在组合层 AbortSignal 贯穿时统一处理（15.9 profile 验证项）。
- 修复后 gates：509 tests / 78 files 全绿，typecheck 0，lint 0，build 通过。
