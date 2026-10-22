#!/usr/bin/env node
/**
 * Real-machine smoke (2026-10-21, review follow-up). One command over a
 * running adapter deployment, REST-first: DOM/CDP is only required for
 * keyboard-driven slash invocation and ephemeral confirm buttons —
 * everything here reads the wire through the bot token instead.
 *
 * Preconditions (see scripts/verify-profile.sh to create the deployment):
 *   - dsh host running with the adapter plugin enabled and connected
 *   - DISCORD_BOT_TOKEN in env (or ~/.dsh/.credentials.yaml resolved)
 *   - optional MEMBER_USER_ID: a NON-admin member for D1 visibility checks
 *
 * Usage: node scripts/real-machine-smoke.mjs --guild <id> --channel <id>
 *
 * Pass criteria: every numbered check prints OK; any FAIL exits 1.
 * Calibration note: endpoints/filters follow the 0.2.1-rc.2 real-machine
 * baseline in AGENTS.md; run once against a live guild and adjust flags.
 */
import process from 'node:process'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(([k]) => k))
const GUILD = args.guild ?? ''
const CHANNEL = args.channel ?? ''
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? ''
const API = 'https://discord.com/api/v10'
if (GUILD === '' || CHANNEL === '' || TOKEN === '') {
  console.error('usage: real-machine-smoke.mjs --guild <id> --channel <id>  (DISCORD_BOT_TOKEN required)')
  process.exit(2)
}

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

async function rest(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bot ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

// 1. Identity: the token is the bot we think it is (chat-transcribed tokens
//    drift — AGENTS.md 2026-10-20).
const me = await rest('GET', '/users/@me')
check('bot identity resolves', me.status === 200, `id=${me.body?.id ?? '?'} bot=${me.body?.bot === true}`)

// 2. Command registrations: all 8 commands present for the guild, and the
//    D1 wire contract holds — default_member_permissions OMITTED ('0' hid
//    commands from ordinary members; the adapter authorizes at interaction
//    time instead).
const APP = me.body?.id ?? ''
const cmds = await rest('GET', `/applications/${APP}/guilds/${GUILD}/commands`)
const names = Array.isArray(cmds.body) ? cmds.body.map(c => c.name).sort() : []
check('8 commands registered', names.length === 8, names.join(','))
// Discord returns the field as null when unset — only a non-null value is a violation.
const withDmp = Array.isArray(cmds.body) ? cmds.body.filter(c => c.default_member_permissions != null) : []
check('D1: default_member_permissions omitted on every command', withDmp.length === 0,
  withDmp.length === 0 ? '' : `offenders: ${withDmp.map(c => c.name).join(',')}`)

// 2b. D1 permission math: with dmp null on every command, any member can
// invoke iff @everyone retains USE_APPLICATION_COMMANDS — provable via
// REST, no member account needed (UI visibility follows deterministically).
const USE_APPLICATION_COMMANDS = 1n << 31n
const everyoneRole = await rest('GET', `/guilds/${GUILD}/roles`)
const everyone = Array.isArray(everyoneRole.body) ? everyoneRole.body.find(r => r.id === GUILD) : undefined
const everyonePerms = BigInt(everyone?.permissions ?? '0')
check('D1: @everyone may invoke commands (USE_APPLICATION_COMMANDS held)', (everyonePerms & USE_APPLICATION_COMMANDS) !== 0n,
  `everyone perms=${everyone?.permissions ?? '?'}`)

// 3. Channel reachable (view/read permissions of the invite).
const ch = await rest('GET', `/channels/${CHANNEL}`)
check('channel readable', ch.status === 200, ch.body?.name ?? String(ch.status))

// 4. Adapter presence: recent bot-authored messages exist in the channel
//    (post-deployment reconcile leaves the workspace channel structure).
const tail = await rest('GET', `/channels/${CHANNEL}/messages?limit=10`)
const botMessages = Array.isArray(tail.body) ? tail.body.filter(m => m.author?.id === APP) : []
check('adapter has spoken in the channel', botMessages.length > 0, `${String(botMessages.length)} recent bot messages`)

// 5. Send + nonce round-trip: one suppressed-notification probe message the
//    smoke deletes afterwards (leave-no-trace).
const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 25)
const probe = await rest('POST', `/channels/${CHANNEL}/messages`, {
  content: `dsh-smoke probe ${nonce.slice(0, 6)}`,
  flags: 4096,
  nonce,
  allowed_mentions: { parse: [] },
})
check('probe send accepted (content ≤2000, nonce ≤25)', probe.status === 200)
if (probe.status === 200 && probe.body?.nonce !== undefined) {
  // Discord echoes the nonce on the created message — assert the round-trip (PR review).
  check('probe nonce echoed unchanged', probe.body.nonce === nonce)
}
if (probe.status === 200) {
  const del = await rest('DELETE', `/channels/${CHANNEL}/messages/${probe.body.id}`)
  check('probe deleted', del.status === 204 || del.status === 200)
}

// 6. Manual checklist (human/CDP steps the wire cannot prove):
console.log(`
MANUAL (CDP or by hand) — required once per release line:
  [ ] member account (MEMBER_USER_ID, non-admin) SEES and runs /model show
      → D1 permission gating; owner-only runs prove nothing
  [ ] @mention → thread creation → streaming edits → finalize renders
  [ ] approval + question buttons: command → click in the SAME tab session
      (ephemeral replies do not survive refresh)
  [ ] DSH_DISCORD_TRACE=1 host log shows ZERO *_failed/*_threw/*_unknown
      events during the above (this session's new warn events are probes)
  [ ] ack latency: slash commands answer well under 3s (C-7 budget)`)

if (args.mode === 'watch') {
  console.log('watching for a mention-created thread (send one now)…')
  const deadline = Date.now() + 180_000
  let threadId = ''
  while (Date.now() < deadline && threadId === '') {
    const active = await rest('GET', `/channels/${CHANNEL}/threads/active`)
    const found = Array.isArray(active.body?.threads) ? active.body.threads.at(-1) : undefined
    if (found !== undefined) {
      const msgs = await rest('GET', `/channels/${found.id}/messages?limit=50`)
      const botMsgs = Array.isArray(msgs.body) ? msgs.body.filter(m => m.author?.id === APP) : []
      if (botMsgs.length >= 2) threadId = found.id
    }
    if (threadId === '') await new Promise(r => { setTimeout(r, 3_000) })
  }
  check('mention → thread with rendered head', threadId !== '', threadId)
  if (threadId !== '') {
    let prev = -1, stable = 0
    while (stable < 3 && Date.now() < deadline) {
      const msgs = await rest('GET', `/channels/${threadId}/messages?limit=50`)
      // Full fingerprint (newest-first API; equal-length edits count).
      const fp = (Array.isArray(msgs.body) ? msgs.body.filter(m => m.author?.id === APP) : [])
        .map(m => `${m.id}:${m.content ?? ''}`).join('|')
      stable = fp === prev ? stable + 1 : 0
      prev = fp
      await new Promise(r => { setTimeout(r, 4_000) })
    }
    check('finalize settles (rendered messages stabilize)', stable >= 3, `${String(prev)} bot messages`)
  }
  if (args.trace !== undefined) {
    const { readFile } = await import('node:fs/promises')
    const log = await readFile(args.trace, 'utf8')
    const failures = log.split('\n').filter(l => l.includes('dsh-discord') && /_(failed|threw|blocked|unknown)\b/.test(l))
    check('trace hygiene: zero failure-shaped events', failures.length === 0, failures.slice(0, 3).join(' | '))
  }
}
process.exit(failed === 0 ? 0 : 1)
