/**
 * Bilingual copy for every user-facing Discord string (design 16.25).
 * The adapter copy language is a plugin setting (`language`: 'zh' | 'en',
 * default 'zh') — the Host locale itself is not exposed to host-side
 * plugins (the settings provider is namespace-scoped). `CopyTable` is a
 * plain object of named members so call sites stay typed and discoverable;
 * the English table is type-checked against the Chinese one, so a missing
 * translation is a compile error.
 */

export type Language = 'zh' | 'en'

const zh = {
  // ── /project bind ────────────────────────────────────────────────────
  bindConfirmButton: '确认绑定',
  bindCancelButton: '取消',
  bindAdminOnly: '⚠️ 只有工作区管理员可以绑定频道。',
  bindUsage: '💡 用法：/project bind workspace:<从候选中选择>',
  bindWorkspaceGone: '⚠️ 该工作区已不存在，请用 /project bind 的候选重新选择。',
  bindWorkspaceUnknown: '⚠️ 工作区目录未在限时内确认（结果未知），请稍后重试。',
  bindWorkspaceUnavailable: '⚠️ 工作区目录暂时不可用，请稍后重试。',
  bindChannelExists: (title: string, existing: string) => `工作区「${title}」的频道已存在于：<#${existing}>`,
  bindConfirmPrompt: (title: string) => `将为工作区「${title}」创建专属频道（DeepSeek Harness 分类下）？`,
  bindCancelled: '已取消，未创建频道。',
  bindChannelFailed: '⚠️ 频道创建失败，请稍后重试。',
  bindChannelCreated: (title: string, channelId: string) => `💡 已为工作区「${title}」创建频道：<#${channelId}>`,
  bindChannelExisting: (title: string, channelId: string) => `💡 工作区「${title}」的频道已存在于：<#${channelId}>`,

  // ── /project list / info ─────────────────────────────────────────────
  listEmpty: '（没有已注册的工作区）',
  listHeader: '**可用工作区**',
  listTruncated: (shown: number, total: number) => `\n（共 ${String(total)} 个，仅列出前 ${String(shown)} 个）`,
  infoUnboundAllowed: '此频道未绑定工作区；请到工作区的专属频道中使用（/project bind 可创建）。',
  infoUnbound: '⚠️ 此频道未绑定工作区。',
  infoMemberOnly: '⚠️ 只有成员可以查看此频道的绑定。',
  infoUnknown: '⚠️ 工作区目录未在限时内确认（结果未知），请稍后重试。',
  infoStale: '⚠️ 绑定的工作区已不存在；请用 /project bind 重新选择。',
  infoUnavailable: '⚠️ 无法读取工作区目录，请稍后重试。',
  infoRevision: (revision: string, binder: string) => `修订 ${revision}（由 <@${binder}> 绑定）`,
  infoPath: (path: string) => `路径：\`${path}\``,
  unknownSubcommand: '💡 未知子命令。',

  // ── /stop /steer /queue ──────────────────────────────────────────────
  stopNotSessionThread: '⚠️ 此频道不是适配器拥有的会话线程。',
  stopNothingRunning: '此线程当前没有可停止的运行中任务。',
  stopNotOwner: '⚠️ 当前运行中的任务不是由此线程提交的，无法停止。',
  stopStopped: '🛑 已停止。',
  stopStoppedQueuePreserved: '🛑 已停止；队列中的待处理消息已保留。',
  stopRejected: '⚠️ DSH 拒绝了停止请求。',
  stopUnknown: '⚠️ 停止结果未知，请到 DSH Web 确认。',
  steerUsage: '💡 用法：/steer prompt:<插话内容>',
  steerNothingRunning: '此线程当前没有运行中的任务可插话。',
  steerNotOwner: '⚠️ 当前任务不是由此线程提交的，无法插话。',
  steerQueued: '↪️ 已插话。',
  steerRejected: '⚠️ DSH 拒绝了插话。',
  steerUnknown: '⚠️ 插话结果未知。',
  queueNotSessionThread: '⚠️ 此频道不是适配器拥有的会话线程。',
  queueRemoveUsage: '💡 用法：/queue remove item:</queue list 中的编号>',
  queueItemNotFound: '未找到该队列项；请先运行 /queue list 获取最新编号。',
  queueRemoved: (summary: string) => `⏳ 已移除：${summary}`,
  queueRemoveRejected: '⚠️ DSH 拒绝了移除请求（该项可能已被处理）。',
  queueRemoveUnknown: '⚠️ 移除结果未知；请用 /queue list 确认后再试。',
  queueNoData: '⚠️ 暂无队列数据（进程可能刚重启）；等待会话活动后会自动同步。',
  queueEmpty: '⏳ （队列为空）',
  queueHeader: '⏳ **队列**',
  queueRemoveHint: '💡 用 `/queue remove <编号>` 移除。',

  // ── guild forget ─────────────────────────────────────────────────────
  forgetOperatorOnly: '⚠️ 只有 Host 操作员可以忘记 Guild。',
  forgetConfirmPrompt: '⚠️ 将删除本 Guild 的全部适配器记录（绑定/意图；DSH 工作区与 Session 不受影响）。确认？',
  forgetConfirmButton: '确认忘记',
  forgetDone: '💡 已忘记本 Guild：适配器记录（绑定/意图）已删除；DSH 工作区与 Session 未受影响。',

  // ── interaction failures / denials ───────────────────────────────────
  commandFailed: '⚠️ 命令处理失败，请稍后重试。',
  confirmNotOwner: '⚠️ 此确认不属于你。',
  submittedAck: '💡 已提交你的选择。',
  unresolvedAck: '⚠️ 应答结果未知；DSH 未确认，请勿重复点击。',
  expiredControl: '⚠️ 此控件已过期或已失效；请重新运行对应命令。',

  // ── question settle copies ───────────────────────────────────────────
  questionSubmitted: '💡 回答已提交。',
  questionDenied: '⚠️ 此问题不属于你。',
  questionAlreadyResolved: '💡 该问题已被处理。',
  questionIncomplete: '💡 还有问题未回答；请完成后再提交。',
  questionInvalid: (reason: string) => `⚠️ 回答无效：${reason}`,
  questionUnresolved: '⚠️ 应答结果未知；DSH 未确认。',
  questionResolvedElsewhere: '💡 该问题已被其他客户端处理。',

  // ── mainline failure copies (per outcome) ────────────────────────────
  mainlineThreadConflict: '⚠️ 这条消息已被用于另一个会话任务，无法重复创建线程。',
  mainlineThreadFailed: '⚠️ 线程创建失败，请稍后重试。',
  mainlineSessionRejected: '⚠️ DSH 拒绝了会话创建（工作区可能已失效）；请稍后重试或重新 /project bind。',
  mainlineSessionUnknown: '⚠️ 会话创建结果未知；请到 DSH Web 确认后再重试，不会自动重复创建。',
  mainlinePromptRejected: '⚠️ DSH 拒绝了任务提交。',
  mainlinePromptUnknown: '⚠️ 任务提交结果未知；为避免重复执行不会自动重发，请确认后重试。',
  continuationRejected: '⚠️ 消息提交被 DSH 拒绝。',
  continuationUnknown: '⚠️ 消息提交结果未知；不会自动重发，请确认后重试。',

  // ── unbound-channel mention affordance ───────────────────────────────
  unboundNoticeAdministrator: '💡 此频道未绑定工作区。工作区管理员可运行 `/project bind` 创建并绑定项目频道。',
  unboundNoticeMember: '💡 此频道未绑定工作区；请工作区管理员运行 `/project bind`。',

  // ── stream renderer ──────────────────────────────────────────────────
  interruptedMarker: '*（已被中断）*',

  // ── /model show / select ─────────────────────────────────────────────
  modelNeedsThread: '⚠️ /model 需要在已绑定 Session 的任务线程中使用（先在项目频道 @ 机器人）。',
  modelShowUnavailable: '⚠️ 模型目录暂时不可用，请稍后重试。',
  modelShowHeader: (sel: string, groups: number) => `**当前模型：** \`${sel}\`\n**可用 provider：** ${String(groups)}`,
  modelShowReasoning: (effort: string) => `\n**推理强度：** \`${effort}\``,
  modelShowNotRoutable: '\n⚠️ 当前 provider 暂时无法服务请求。',
  modelShowFailures: (names: string) => `\n⚠️ 目录加载失败的 provider：${names}`,
  modelShowNoGroups: '\n（当前没有 provider 提供模型）',
  modelSelectOperatorOnly: '⚠️ 只有 Host 操作员可以切换模型（此操作会切换当前 Session 并更新 Host 默认）。',
  modelSelectNoModels: '⚠️ 当前没有 provider 提供模型，无法选择。',
  modelCascadeProviderHeader: (current: string, extra: string) => `当前模型：\`${current}\`${extra}\n请选择 provider：`,
  modelCascadeProviderPlaceholder: '选择 provider',
  modelCascadeModelHeader: (provider: string) => `Provider：**${provider}**\n请选择模型：`,
  modelCascadeModelPlaceholder: '选择模型',
  modelCascadeReasoningHeader: (model: string) => `模型：**${model}**\n请选择推理强度：`,
  modelCascadeReasoningPlaceholder: '选择推理强度',
  modelCascadeReasoningDefault: '跟随默认',
  modelCascadeReasoningDefaultHint: '使用 provider/默认推理行为',
  modelCascadeTruncated: (shown: number, total: number) => `（共 ${String(total)} 项，仅显示前 ${String(shown)} 项）`,
  modelCascadeExpired: '⚠️ 该选择已过期，请重新运行 /model select。',
  modelApplied: (sel: string) => `✅ 已应用到当前 Session：\`${sel}\`，并已请求 DSH 记为 Host 默认。`,
  modelSelectUnknown: '⚠️ 选择结果未知（请求可能未送达），请用 /model show 确认。',
  modelSelectRejected: (reason: string) => `⚠️ DSH 拒绝了此次选择：${reason}`,
  modelNotInCatalog: '⚠️ 该 provider/模型不在当前会话的目录中。',
  modelInvalidReasoning: '⚠️ 该推理强度对此模型无效。',
  modelTypedParseFailed: '⚠️ 模型需按 `provider/model` 格式填写，或留空进入交互式选择。',

  // ── /session resume ──────────────────────────────────────────────────
  sessionResumeNeedsBoundChannel: '⚠️ /session resume 需要在已绑定工作区的项目频道中使用。',
  sessionResumeStarted: (threadId: string) => `✅ 会话已恢复到 <#${threadId}>——历史在 Web 界面查看，线程内直接续聊。`,
  sessionResumeAlreadyBound: (threadId: string) => `该会话已在 <#${threadId}> 中。`,
  sessionResumeFailed: '⚠️ 会话恢复失败，请稍后重试。',
  sessionResumeAnchor: (title: string) => `📌 恢复会话：${title}`,
  sessionResumeControlChannel: 'general 是控制频道，不承载会话——请到工作区频道使用 /session resume。',
  // ── approval / question cards ────────────────────────────────────────
  approvalRequired: (label: string) => `Approval required — ${label}`,
} satisfies Record<string, unknown>

export type CopyTable = typeof zh

const en: CopyTable = {
  bindConfirmButton: 'Confirm bind',
  bindCancelButton: 'Cancel',
  bindAdminOnly: '⚠️ Only workspace administrators can bind channels.',
  bindUsage: '💡 Usage: /project bind workspace:<pick from candidates>',
  bindWorkspaceGone: '⚠️ That workspace no longer exists; pick again from /project bind candidates.',
  bindWorkspaceUnknown: '⚠️ The workspace directory could not be confirmed in time (unknown); try again later.',
  bindWorkspaceUnavailable: '⚠️ The workspace directory is temporarily unavailable; try again later.',
  bindChannelExists: (title, existing) => `A channel for workspace "${title}" already exists at <#${existing}>`,
  bindConfirmPrompt: title => `Create a dedicated channel for workspace "${title}" (under the DeepSeek Harness category)?`,
  bindCancelled: 'Cancelled — no channel was created.',
  bindChannelFailed: '⚠️ Channel creation failed; try again later.',
  bindChannelCreated: (title, channelId) => `💡 Created a channel for workspace "${title}": <#${channelId}>`,
  bindChannelExisting: (title, channelId) => `💡 Workspace "${title}" already has a channel: <#${channelId}>`,

  listEmpty: '(no registered workspaces)',
  listHeader: '**Available workspaces**',
  listTruncated: (shown, total) => `\n(showing ${String(shown)} of ${String(total)})`,
  infoUnboundAllowed: 'This channel is not bound to a workspace; use the workspace home channel (/project bind creates one).',
  infoUnbound: '⚠️ This channel is not bound to a workspace.',
  infoMemberOnly: '⚠️ Only members can view this channel binding.',
  infoUnknown: '⚠️ The workspace directory could not be confirmed in time (unknown); try again later.',
  infoStale: '⚠️ The bound workspace no longer exists; re-run /project bind.',
  infoUnavailable: '⚠️ The workspace directory is temporarily unavailable; try again later.',
  infoRevision: (revision, binder) => `Revision ${revision} (bound by <@${binder}>)`,
  infoPath: path => `Path: \`${path}\``,
  unknownSubcommand: '💡 Unknown subcommand.',

  stopNotSessionThread: '⚠️ This channel is not an adapter-owned session thread.',
  stopNothingRunning: 'This thread has no running task to stop.',
  stopNotOwner: '⚠️ The running task was not submitted from this thread and cannot be stopped here.',
  stopStopped: '🛑 Stopped.',
  stopStoppedQueuePreserved: '🛑 Stopped; queued messages are preserved.',
  stopRejected: '⚠️ DSH rejected the stop request.',
  stopUnknown: '⚠️ Stop outcome unknown; check the DSH web console.',
  steerUsage: '💡 Usage: /steer prompt:<steering text>',
  steerNothingRunning: 'This thread has no running task to steer.',
  steerNotOwner: '⚠️ The running task was not submitted from this thread and cannot be steered here.',
  steerQueued: '↪️ Steering delivered.',
  steerRejected: '⚠️ DSH rejected the steering.',
  steerUnknown: '⚠️ Steering outcome unknown.',
  queueNotSessionThread: '⚠️ This channel is not an adapter-owned session thread.',
  queueRemoveUsage: '💡 Usage: /queue remove item:<position from /queue list>',
  queueItemNotFound: 'Queue item not found; run /queue list for fresh positions.',
  queueRemoved: summary => `⏳ Removed: ${summary}`,
  queueRemoveRejected: '⚠️ DSH rejected the removal (the item may already be handled).',
  queueRemoveUnknown: '⚠️ Removal outcome unknown; verify with /queue list and retry.',
  queueNoData: '⚠️ No queue data yet (the process may have just restarted); it syncs after session activity.',
  queueEmpty: '⏳ (queue is empty)',
  queueHeader: '⏳ **Queue**',
  queueRemoveHint: '💡 Use `/queue remove <position>` to remove.',

  forgetOperatorOnly: '⚠️ Only Host operators can forget a Guild.',
  forgetConfirmPrompt: '⚠️ This deletes every adapter-owned record for this Guild (bindings/intents; DSH workspaces and sessions are untouched). Continue?',
  forgetConfirmButton: 'Confirm forget',
  forgetDone: '💡 Guild forgotten: adapter records (bindings/intents) are deleted; DSH workspaces and sessions are untouched.',

  commandFailed: '⚠️ Command handling failed; try again later.',
  confirmNotOwner: '⚠️ This confirmation is not yours.',
  submittedAck: '💡 Your choice has been submitted.',
  unresolvedAck: '⚠️ Outcome unknown; DSH did not confirm — do not repeat the click.',
  expiredControl: '⚠️ This control has expired or is no longer valid; run the command again.',

  questionSubmitted: '💡 Answers submitted.',
  questionDenied: '⚠️ This question is not yours.',
  questionAlreadyResolved: '💡 This question has already been handled.',
  questionIncomplete: '💡 Some questions are unanswered; complete them before submitting.',
  questionInvalid: reason => `⚠️ Invalid answer: ${reason}`,
  questionUnresolved: '⚠️ Outcome unknown; DSH did not confirm.',
  questionResolvedElsewhere: '💡 This question was already handled by another client.',

  mainlineThreadConflict: '⚠️ This message was already used for another session task; the thread cannot be recreated.',
  mainlineThreadFailed: '⚠️ Thread creation failed; try again later.',
  mainlineSessionRejected: '⚠️ DSH rejected the session creation (the workspace may be stale); try again later or re-run /project bind.',
  mainlineSessionUnknown: '⚠️ Session creation outcome unknown; confirm on the DSH web console before retrying. It will not be resubmitted automatically.',
  mainlinePromptRejected: '⚠️ DSH rejected the task submission.',
  mainlinePromptUnknown: '⚠️ Task submission outcome unknown; it will not be resent automatically to avoid double execution. Confirm and retry.',
  continuationRejected: '⚠️ The message submission was rejected by DSH.',
  continuationUnknown: '⚠️ Message submission outcome unknown; it will not be resent automatically. Confirm and retry.',

  unboundNoticeAdministrator: '💡 This channel is not bound to a workspace. A workspace administrator can run `/project bind` to create and bind the project channel.',
  unboundNoticeMember: '💡 This channel is not bound to a workspace; ask a workspace administrator to run `/project bind`.',

  interruptedMarker: '*(interrupted)*',

  // ── /model show / select ─────────────────────────────────────────────
  modelNeedsThread: '⚠️ /model needs a thread bound to a Session (mention the bot in a project channel first).',
  modelShowUnavailable: '⚠️ The model catalog is temporarily unavailable; try again later.',
  modelShowHeader: (sel, groups) => `**Current model:** \`${sel}\`\n**Available providers:** ${String(groups)}`,
  modelShowReasoning: effort => `\n**Reasoning effort:** \`${effort}\``,
  modelShowNotRoutable: '\n⚠️ The current provider is not serving requests right now.',
  modelShowFailures: names => `\n⚠️ Providers failing catalog lookup: ${names}`,
  modelShowNoGroups: '\n(no providers currently advertise models)',
  modelSelectOperatorOnly: '⚠️ Only Host operators can switch the model (it switches this Session and updates the Host default).',
  modelSelectNoModels: '⚠️ No providers currently advertise models; nothing to select.',
  modelCascadeProviderHeader: (current, extra) => `Current model: \`${current}\`${extra}\nSelect a provider:`,
  modelCascadeProviderPlaceholder: 'Select a provider',
  modelCascadeModelHeader: provider => `Provider: **${provider}**\nSelect a model:`,
  modelCascadeModelPlaceholder: 'Select a model',
  modelCascadeReasoningHeader: model => `Model: **${model}**\nSelect a reasoning effort:`,
  modelCascadeReasoningPlaceholder: 'Select a reasoning effort',
  modelCascadeReasoningDefault: 'Provider default',
  modelCascadeReasoningDefaultHint: 'Use the provider/default reasoning behavior',
  modelCascadeTruncated: (shown, total) => `(${String(total)} total, showing the first ${String(shown)})`,
  modelCascadeExpired: '⚠️ This selection expired; run /model select again.',
  modelApplied: sel => `✅ Applied to this session: \`${sel}\`. DSH has also been asked to record it as the Host default.`,
  modelSelectUnknown: '⚠️ The selection outcome is unknown (the request may not have landed); check /model show.',
  modelSelectRejected: reason => `⚠️ DSH rejected the selection: ${reason}`,
  modelNotInCatalog: "⚠️ That provider/model is not in this session's catalog.",
  modelInvalidReasoning: '⚠️ That reasoning effort is not valid for this model.',
  modelTypedParseFailed: '⚠️ The model must be `provider/model`, or left empty for the interactive cascade.',

  // ── /session resume ──────────────────────────────────────────────────
  sessionResumeNeedsBoundChannel: '⚠️ /session resume must run in a bound project channel.',
  sessionResumeStarted: threadId => `✅ Session resumed into <#${threadId}> — full history lives in the web UI; continue in the thread.`,
  sessionResumeAlreadyBound: threadId => `This session already lives in <#${threadId}>.`,
  sessionResumeFailed: '⚠️ Resuming the session failed; try again later.',
  sessionResumeAnchor: title => `📌 Resumed session: ${title}`,
  sessionResumeControlChannel: 'general is the control channel and carries no sessions — use /session resume in a workspace channel.',

  // ── approval / question cards ────────────────────────────────────────
  approvalRequired: label => `Approval required — ${label}`,
}

/** Discord-visible copy for the configured language. */
export function createCopy(language: Language): CopyTable {
  return language === 'en' ? en : zh
}
