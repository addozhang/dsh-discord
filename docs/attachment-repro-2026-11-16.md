# Discord thread 发文件 DSH 收不到 —— 真机复现报告

日期：2026-11-16 · 环境：web-test（测试环境）· 结论：**100% 复现，已修复并真机复验通过**

> 2026-11-16 后续更新：本文前半是「复现阶段」记录；修复与最终五组真机复验见文末。
> 其中 D 组（图片）的原始判读**是错的** —— 图片 modality 门本来就是通的，
> 1×1 探针 PNG 被宿主判为 `INVALID_IMAGE`，详见「图片 modality 门的真相」。

## 结论先行

适配器**只把 4 种图片 MIME 当作附件**，其余文件类型在入站层就被静默丢弃：

| 发送形态 | DSH 表现 |
|---|---|
| 只发文件（非图片）、不带文字 | **完全静默**：不进路由、trace 零输出、线程零回复、无任何错误提示 |
| 文件 + 文字 | 文字正常跑 turn，但**文件内容不进 prompt**（模型实测答 `NO_FILE`） |
| 只发图片（PNG） | 能进路由，但被 DSH `session/attachment-invalid` 拒绝并给出可见错误（当时误判为 modality 门，实际 reason 是 `INVALID_IMAGE`，见文末更正） |

因此用户感知的「收不到」实际是两种形态：纯文件 = 石沉大海；带文字 = 文字过去了、文件丢了。

## 环境（按真机测试铁律，未碰 desktop）

| 项 | 值 |
|---|---|
| CLI 宿主 | `dsh 0.2.2-rc.3`，`--profile web-test --no-open --port 3081` |
| 插件 | `@addozhang/dsh-discord@0.6.9`（npm 发布版，非本地构建） |
| guild / bot | Bot Test Server `1562450757805146123` / DSH Test `1550676723773739048` |
| 发消息身份 | 真人账号 `983289424819417089`（在 `memberUserIds` 内），经 CDP 驱动 Discord UI |
| 目标 thread | `1570578694244794530`（测试 guild 唯一绑定会话，parent = 已绑定频道 `1562614126172184586`） |
| trace | `DSH_DISCORD_TRACE=1` → `/tmp/web-test-attach-repro.log`，每组按字节窗口只扫增量 |

**为什么不能用 bot token 发**：`parseMessage()` 会把 `author.bot === true` 的消息以
`bot-authored` 拒掉，那样测出来的是另一个拒绝原因，属假复现。文件改由
`DOM.setFileInputFiles` 注入 Discord 自己的 `<input type=file>`，等价于真人选文件。

## 复现脚本

本次新增 `scripts/devtools-cdp-attachment.mjs`：参数化 `--thread / --text / --file /
--label / --wait / --trace`，一次运行同时产出三类证据 —— REST 读回的 wire 消息形状、
线程内新增 bot 消息、trace 增量。

```sh
DISCORD_BOT_TOKEN=$(grep -m1 DSH_DISCORD_BOT_TOKEN \
  ~/.dsh/profiles/web-test/.credentials.yaml \
  | sed -E 's/^[^:]*: *//; s/^["'"'"']//; s/["'"'"']$//') \
  node scripts/devtools-cdp-attachment.mjs \
    --thread 1570578694244794530 --file /tmp/dsh-attach-probe.txt \
    --label B-file-only --wait 30 --trace /tmp/web-test-attach-repro.log
```

样本：`/tmp/dsh-attach-probe.txt`（249 B，含唯一标记
`DSH_ATTACH_PROBE_9C21=ALPHA-BRAVO-42`）、`/tmp/dsh-attach-probe.png`（1×1 PNG，70 B）。

## 四组结果

| 组 | 输入 | Discord wire 实况 | 线程内新 bot 消息 | trace 增量 | 判定 |
|---|---|---|---|---|---|
| A 对照 | 纯文本「只回复两个字：收到」 | `type=0`, `content` 非空, `attachments=0` | 1 条：`收到` | 83 行（含 `inbox.next-turn`、`discord_turn_ended`） | 通道/授权/绑定/宿主全正常 |
| **B 复现** | 只发 `dsh-attach-probe.txt` | `id=1571692012279963740`, `type=0`, `content=""`, `author=983289424819417089`, `bot=false`, `attachments=1` = `text/plain; charset=utf-8` / 249 B | **0** | **0 行** | **完全静默丢弃** |
| **C 复现** | 文字 + 同一 txt | `id=1571692316568060084`, `type=0`, `attachments=1` | 1 条：`NO_FILE` | 280 行，turn 正常结束 | 只有文字进 prompt |
| D 对照 | 只发 PNG | `id=1571692502174662767`, `type=0`, `content=""`, `attachments=1` = `image/png` / 70 B | 1 条：`⚠️ The message submission was rejected by DSH.` | 2 行：`discord_prompt_submit_rejected: {"code":"session/attachment-invalid"}` / `discord_continuation_not_queued: rejected` | 图片能进路由，被 modality 门拒 |

关键旁证：A 与 C/D 都是同账号、同 thread、同 `type=0` 的 `MESSAGE_CREATE`，均成功触发宿主动作 → B 的「零反应」不可能归因于 gateway / 白名单 / 宿主没起。

trace 中宿主实际提交的 prompt parts（权威证据，不是模型自述）：

```
seq 31 (A) parts [{"type":"text","text":"只回复两个字：收到"}]
seq 43 (C) parts [{"type":"text","text":"不要调用任何工具…"}]
```

C 组明明带了一个附件，`content` 仍只有**一个 text part**，没有任何 image/file part。

## 根因定位（代码）

1. `src/gateway/inbound.ts:144-150, 160-178` — `extractImages()` 的
   `SUPPORTED_IMAGE_TYPES` 白名单只有 `image/jpeg|png|webp|gif`；`text/plain;
   charset=utf-8` 命中 `!SUPPORTED_IMAGE_TYPES.has(contentType)` 被 `continue`
   跳过 → `images: []`。`NormalizedMessage` 本身**没有通用 attachments 字段**
   （只有 `images`），非图片附件在归一化边界就蒸发了。
2. `src/compose.ts:153-161` — `hasTask = prompt !== '' || images.length > 0`；
   绑定 thread 分支里 `if (!hasTask) return`。纯附件消息 `prompt === ''`
   且 `images.length === 0` → 直接 return，**没有日志、没有 warn、没有给用户任何提示**。
   这与 B 组「trace 增量 0 行」完全吻合（连 `discord_dispatch_rejected` 都不会有，
   因为消息其实被 `parseMessage` 接受了，是路由层主动放弃）。
3. `src/features/prompt-submission.ts` / `src/dsh/host-face.ts:516` —
   提交给宿主的 parts 只拼 text + images，没有文件通道，所以 C 组模型只看到文字。
4. 图片是另一条路：`images.length > 0` 让 `hasTask` 成立 → 进入 `continueInThread`
   → 抛 `session/attachment-invalid`，线程里给出可见错误。它是**明确报错**，与本次
   「静默吞掉」是不同缺陷。
   **更正（当日后续）**：这里把拒绝归因于「未开图片 modality」是错的。真实 reason
   是 `INVALID_IMAGE`（1×1 / 70 B 探针图不可解码），模型能力本来就是
   `[text, image]`。详见「图片 modality 门的真相」。

## 修复实现（16.114）

先补测试再实现（RED→GREEN），全量 `93 files / 891 tests` 通过。

1. **通用附件归一化**：`src/gateway/inbound.ts` 新增 `DiscordFileAttachment` 与
   `NormalizedMessage.files`；`extractFiles()` 保留所有非图片附件并打
   `textCapable` 标记（MIME 归一后按 `text/*` + `application/json` / `xml` / `yaml` 等
   白名单）；图片 MIME 支持带参数形式（如 `image/png; charset=binary`）。
2. **文件文本化边界**：新建 `src/features/file-collection.ts` —— CDN allowlist
   （`cdn.discordapp.com` / `media.discordapp.net`、HTTPS、单跳 redirect 每跳复验）、
   单文件 256 KiB / 聚合 512 KiB / 最多 10 个、严格 UTF-8、拒绝二进制控制字符、
   超时与实际 body 大小校验；产出带 label 的 text part。
3. **打通到宿主**：`textParts` 依次经 `compose.ts` → `session-mainline.ts` →
   `prompt-submission.ts` → `host-face.ts`，作为额外 `text` part 提交（宿主
   `session.prompt` content union 只有 text/image，没有 file part）。`contentHash`
   覆盖附件文本，保证 at-most-once 不把「同 id 换文件」误判为 replay。
4. **不再静默**：`compose.ts` 的 `hasTask` 纳入 files；unsupported 二进制附件走
   `attachmentNotice` 发可见提示；`file-failed` / 图片下载失败各有文案；
   `echoRedact` 用 `stripAttachedFileBlocks()` 阻止文件内容被 user-echo 刷回 thread。
5. **Host 拒绝按 reason 分流**：`RemoteError.details.reason` 从 `host-face.ts` 一路
   透传到组合根，`src/i18n.ts` 的 `attachmentRejectionCopy()` 只在
   `MODEL_DOES_NOT_SUPPORT_IMAGES` 时提示改模型，其余 reason 用
   `attachmentRejected`（文件格式/大小），并把 `detail` 写进 trace。

新增/修改测试：`test/file-collection.test.ts`（新建）、`inbound`、`compose`、
`session-mainline`、`prompt-submission`、`host-face`、`twin-smoke`、`i18n`。

## 图片 modality 门的真相（更正复现阶段的误判）

复现阶段把 `session/attachment-invalid` 一律读成「模型不支持图片」，并据此往
`cordis.patch.yml` 写过 `llm-pi-ai / zai-coding-cn / glm-5.3` 的 `input` 覆盖 ——
**该配置从未生效，且已被移除**。排查链：

- `/model show` 实为 `deepseek-official/deepseek-flash`，走 `llm-deepseek-api-key`
  路由（不是 pi-ai）；会话 journal 也确认该 session 一直用这个模型。
- `dsh-llm-deepseek` 内置目录（`src/models.ts`）与官方
  `https://api.deepseek.com/models` listing **都声明** `deepseek-flash` 为
  `["text","image"]`；用宿主自己的 `parseModelListing` +
  `resolveListedCatalog` 复算，`catalogModelInfo(...)` 明确返回
  `inputModalities: ["text","image"]`。清理 profile patch 后拒绝依旧，排除配置层。
- 换成 256×256 真实 PNG 后**图片立刻跑通**，模型准确描述画面 → 门本来就是通的。
- 决定性证据：宿主 `session/attachment-invalid` 的 `details.reason` 有多种取值
  （`image-labels.ts`：`INVALID_IMAGE` / `IMAGE_TYPE_MISMATCH` / `IMAGE_TOO_LARGE` /
  `FILE_NOT_STAGED` / `MODEL_DOES_NOT_SUPPORT_IMAGES` …）。1×1 / 70 B 探针图
  被判 `INVALID_IMAGE`，与模型能力无关。

**教训**：错误码不是失败原因；`code` 相同而 `details.reason` 不同时，按 code
给用户的可操作建议必然错。真机探针样本也要用真实素材。

## 最终真机复验（本地构建 0.6.9，web-test，trace `/tmp/web-test-final-verify.log`）

| 组 | 输入 | 结果 |
|---|---|---|
| A | 纯文本 | `收到` —— 通道/授权/绑定正常 |
| B | 只发 txt | 模型读到 marker：`文件内容已收到，其中 marker 值为 DSH_ATTACH_PROBE_9C21=ALPHA-BRAVO-42` |
| C | 文字 + txt | 精确输出 `DSH_ATTACH_PROBE_9C21=ALPHA-BRAVO-42`（原为 `NO_FILE`） |
| D1 | 1×1 PNG（无效图） | 新文案 `⚠️ DSH rejected the attachment ... Check the file format and size, then retry.`；trace `discord_prompt_submit_rejected: {"code":"session/attachment-invalid","detail":"INVALID_IMAGE",...}` |
| D2 | 256×256 PNG | 正常 turn；模型描述「256×256，四角四色渐变，正中白色方块」 |

全量校验：`pnpm typecheck` / `pnpm lint` / `pnpm test`（93 files、891 tests）/
`pnpm build` / `pnpm pack` 全绿；安装副本与 tarball `diff -rq` 一致；
`dsh plugin --profile web-test rm/add` 后重启宿主复验。

## 环境与遗留

- web-test 宿主仍在 3081 运行；**desktop 正式环境全程未动**。
- `/Users/addo/.dsh/profiles/web-test/cordis.patch.yml` 已移除无效的
  `llm-pi-ai` 覆盖，最终**不需要任何模型能力配置**；备份留在
  `cordis.patch.yml.bak-attach-20261116` / `.bak-before-image-fix`。
- 本地构建版本号仍是 0.6.9（未发版）；本次改动尚未提交，发版需用户确认。
- 测试痕迹：目标 thread 内本轮新增 5 条真人消息 + 5 条 bot 消息。
