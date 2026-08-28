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
