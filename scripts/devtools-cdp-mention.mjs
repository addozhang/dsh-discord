#!/usr/bin/env node
/**
 * CDP mention-flow driver (2026-10-22): the LAST human trigger, automated.
 * Types an @mention in the logged-in Discord (autocomplete: [role=option]
 * rows, prefix-matched), sends the task, then verifies the whole artifact
 * chain over REST (thread → rendered head → finalize settles) and scans
 * the host trace for failure-shaped events.
 *
 * Usage:
 *   node scripts/devtools-cdp-mention.mjs "任务描述" [--trace /tmp/web-test-3081.log]
 */
import process from 'node:process'
import { readFile } from 'node:fs/promises'

const TASK = process.argv[2] ?? '列出当前目录的文件名,一句话即可'
const TRACE = (() => { const i = process.argv.indexOf('--trace'); return i > 0 ? process.argv[i + 1] : undefined })()
const CDP_HTTP = 'http://127.0.0.1:9222'
const GUILD = process.env.GUILD ?? '1562450757805146123'
const CHANNEL = process.env.CHANNEL_ID ?? '1562604323509108830'
const CHANNEL_URL = `https://discord.com/channels/${GUILD}/${CHANNEL}`
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? ''
const API = 'https://discord.com/api/v10'
const sleep = (ms) => new Promise(r => { setTimeout(r, ms) })
const TRACE_OFFSET = TRACE === undefined ? 0 : (await import('node:fs')).statSync(TRACE).size

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

async function rest(method, path) {
  const response = await fetch(`${API}${path}`, { method, headers: { authorization: `Bot ${TOKEN}` } })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

async function main() {
  // ── CDP: send the mention ──
  const targets = await (await fetch(`${CDP_HTTP}/json`)).json()
  const page = targets.find(t => t.type === 'page' && t.url.includes('discord.com/channels/'))
  if (page === undefined) throw new Error('no discord tab')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  }
  const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
  const key = (k) => send('Input.dispatchKeyEvent', k)
  const typeChar = async (char) => {
    const upper = char.toUpperCase()
    await key({ type: 'keyDown', key: char, text: char, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), unmodifiedText: char })
    await key({ type: 'keyUp', key: char, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) })
    await sleep(30)
  }

  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  if (!page.url.includes(CHANNEL)) {
    await send('Page.navigate', { url: CHANNEL_URL })
    await sleep(4_000)
  }
  const focused = await evaluate(`(() => { const b = document.querySelector('[role=textbox]'); if (b === null) return false; b.focus(); return document.activeElement === b })()`)
  if (focused !== true) throw new Error('textbox not focusable')

  let options = []
  for (let attempt = 0; attempt < 4 && options.length === 0; attempt += 1) {
    await evaluate(`document.querySelector('[role=textbox]')?.focus()`)
    await sleep(500)
    // Clear any leftover text (select-all + delete; never touch Slate internals).
    await key({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await key({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await key({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await key({ type: 'keyUp', key: 'Backspace', code: 'Backspace' })
    for (const char of '@dsh') await typeChar(char)
    await sleep(1_500)
    options = (await evaluate(`[...document.querySelectorAll('[role=option]')].map(o => (o.textContent ?? '').trim()).filter(Boolean).slice(0, 6)`)) ?? []
  }
  if (options.length === 0) {
    ws.close()
    throw new Error('mention autocomplete empty after "@dsh" retries')
  }
  console.log(`autocomplete rows: ${options.join(' | ')}`)
  await key({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(500)
  for (const char of ` ${TASK}`) await typeChar(char)
  await sleep(300)
  await key({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const preSendLastId = await evaluate(`(() => {
    const items = document.querySelectorAll('[data-list-item-id]')
    return items.length === 0 ? '' : (items[items.length - 1].getAttribute('data-list-item-id') ?? '')
  })()`)
  console.log('mention sent — switching to REST verification')
  ws.close()

  if (TOKEN === '') throw new Error('DISCORD_BOT_TOKEN required for verification')

  // ── REST: verify the artifact chain ──
  const deadline = Date.now() + 240_000
  let threadId = ''
  while (Date.now() < deadline && threadId === '') {
    // Thread discovery: threads/active can lag; the adapter's anchored
    // threads carry id == anchor message id, so probe the channel's recent
    // message ids directly as thread ids too.
    let found
    const recent = await rest('GET', `/channels/${CHANNEL}/messages?limit=5`)
    if (Array.isArray(recent.body)) {
      for (const message of recent.body) {
        // Tie discovery to THIS run (PR re-review): only messages newer
        // than our pre-send last message can be this run's anchor.
        if (preSendLastId !== '' && message.id <= preSendLastId) continue
        const probe = await rest('GET', `/channels/${message.id}`)
        // Public threads are channel type 11 (no `thread` flag exists).
      if (probe.status === 200 && probe.body?.type === 11 && probe.body?.parent_id === CHANNEL) { found = probe.body; break }
      }
    }
    if (found === undefined) {
      const active = await rest('GET', `/guilds/${GUILD}/threads/active`)
      found = Array.isArray(active.body?.threads)
        ? active.body.threads.filter(t => t.parent_id === CHANNEL).at(-1)
        : undefined
    }
    if (found !== undefined) {
      const msgs = await rest('GET', `/channels/${found.id}/messages?limit=50`)
      const botMsgs = Array.isArray(msgs.body) ? msgs.body.filter(m => m.author?.id === '1550676723773739048') : []
      if (botMsgs.length >= 2) threadId = found.id
    }
    if (threadId === '') await sleep(4_000)
  }
  check('mention → thread with rendered head', threadId !== '', threadId)

  if (threadId !== '') {
    // Count AND last-content fingerprint: streaming edits in place (PR review).
    let prev = '', stable = 0
    while (stable < 3 && Date.now() < deadline) {
      const msgs = await rest('GET', `/channels/${threadId}/messages?limit=50`)
      const bot = Array.isArray(msgs.body) ? msgs.body.filter(m => m.author?.id === '1550676723773739048') : []
      const fp = `${String(bot.length)}:${(bot.at(-1)?.id ?? '')}:${String((bot.at(-1)?.content ?? '').length)}`
      stable = fp === prev ? stable + 1 : 0
      prev = fp
      await sleep(5_000)
    }
    check('finalize settles (messages stabilize)', stable >= 3, `${String(prev)} bot messages`)
    const tail = await rest('GET', `/channels/${threadId}/messages?limit=10`)
    const last = Array.isArray(tail.body) ? (tail.body.at(-1)?.content ?? '').slice(0, 120) : ''
    console.log(`last render: ${last}`)
  }

  if (TRACE !== undefined) {
    // Window the scan to bytes appended since the run began — stale
    // warnings from earlier sessions are out of scope.
    const raw = await readFile(TRACE)
    const windowed = raw.subarray(TRACE_OFFSET).toString('utf8')
    const failures = windowed.split('\n').filter(l => l.includes('dsh-discord') && /_(failed|threw|blocked|unknown)\b/.test(l))
    check('trace hygiene: zero failure-shaped events', failures.length === 0, failures.slice(0, 3).join(' | '))
  }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(cause => { console.error(String(cause)); process.exit(2) })
