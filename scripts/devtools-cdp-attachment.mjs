#!/usr/bin/env node
/**
 * Real-machine reproduction: a file attached to a message in a bound Discord
 * thread never reaches DSH (2026-11-16).
 *
 * The message MUST be authored by the logged-in human account. Posting over
 * REST with the bot token is rejected by parseMessage() as `bot-authored`,
 * i.e. a false reproduction. Files are injected with CDP's
 * DOM.setFileInputFiles into Discord's own <input type=file>, the same path a
 * user's file picker takes, then sent with Enter.
 *
 * Reports two independent facts:
 *   1. what Discord actually stored (message type / content / attachments),
 *      read back over REST with the bot token — authoritative wire evidence;
 *   2. what DSH did about it (new bot messages in the thread + trace delta).
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=... node scripts/devtools-cdp-attachment.mjs \
 *     --thread <id> [--text "..."] [--file /abs/path] [--label A] \
 *     [--wait 45] [--trace /tmp/web-test-attach-repro.log]
 */
import process from 'node:process'
import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(([k]) => k),
)
const GUILD = process.env.GUILD ?? '1562450757805146123'
const THREAD = args.thread ?? '1570578694244794530'
const TEXT = args.text ?? ''
const FILE = args.file
const LABEL = args.label ?? 'run'
const WAIT = Number(args.wait ?? 45)
const TRACE = args.trace ?? '/tmp/web-test-attach-repro.log'
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? ''
const BOT_ID = '1550676723773739048'
const API = 'https://discord.com/api/v10'
const CDP = 'http://127.0.0.1:9222'
const sleep = ms => new Promise(r => { setTimeout(r, ms) })
const TRACE_OFFSET = statSync(TRACE).size

async function rest(method, path) {
  const response = await fetch(`${API}${path}`, { method, headers: { authorization: `Bot ${TOKEN}` } })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      let seq = 0
      const pending = new Map()
      ws.onmessage = event => {
        const message = JSON.parse(event.data)
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message)
          pending.delete(message.id)
        }
      }
      const send = (method, params = {}) => new Promise(done => {
        const id = ++seq
        pending.set(id, done)
        ws.send(JSON.stringify({ id, method, params }))
      })
      resolve({
        ws,
        send,
        evaluate: async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value,
        objectId: async expression => (await send('Runtime.evaluate', { expression })).result?.result?.objectId,
        key: params => send('Input.dispatchKeyEvent', params),
      })
    }
    ws.onerror = reject
  })
}

async function main() {
  if (TOKEN === '') throw new Error('DISCORD_BOT_TOKEN required (read the web-test profile credential file)')

  const before = await rest('GET', `/channels/${THREAD}/messages?limit=50`)
  const preLastId = Array.isArray(before.body) && before.body.length > 0 ? before.body[0].id : ''
  // Snowflake ids are ordered: compare against the pre-send head instead of
  // a bounded id set, so older thread history is never counted as "new".
  const isNew = (id) => preLastId !== '' && BigInt(id) > BigInt(preLastId)

  const targets = await (await fetch(`${CDP}/json`)).json()
  const page = targets.find(t => t.type === 'page' && t.url.includes('discord.com/channels/'))
  if (page === undefined) throw new Error('no discord.com/channels tab')
  const cdp = await connect(page)
  const { send, evaluate, objectId, key } = cdp

  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const threadUrl = `https://discord.com/channels/${GUILD}/${THREAD}`
  if (!page.url.includes(THREAD)) {
    await send('Page.navigate', { url: threadUrl })
    await sleep(5_000)
  }

  // Focus the composer and clear it with real key events (never touch Slate internals).
  const focused = await evaluate(`(() => { const b = document.querySelector('[role=textbox]'); if (b === null) return false; b.focus(); return document.activeElement === b })()`)
  if (focused !== true) throw new Error('textbox not focusable')
  await key({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await key({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await key({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await key({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })

  // Inject the file through Discord's own hidden file input.
  if (FILE !== undefined) {
    const oid = await objectId(`document.querySelector('input[type=file]')`)
    if (oid === undefined) throw new Error('Discord file input not found')
    const set = await send('DOM.setFileInputFiles', { files: [FILE], objectId: oid })
    if (set.error !== undefined) throw new Error(`DOM.setFileInputFiles: ${JSON.stringify(set.error)}`)
    await sleep(2_500)
    const names = await evaluate(`[...document.querySelectorAll('input[type=file]')].flatMap(i => [...(i.files ?? [])].map(f => f.name))`)
    console.log(`[${LABEL}] file staged in composer: ${JSON.stringify(names)}`)
  }

  if (TEXT !== '') {
    await evaluate(`document.querySelector('[role=textbox]')?.focus()`)
    await send('Input.insertText', { text: TEXT })
    await sleep(500)
  }
  await key({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  cdp.ws.close()

  // ── 1. Wire evidence: what did Discord actually store? ──
  let sent
  for (let i = 0; i < 12 && sent === undefined; i += 1) {
    const r = await rest('GET', `/channels/${THREAD}/messages?limit=10`)
    sent = Array.isArray(r.body) ? r.body.find(m => isNew(m.id) && m.author?.id !== BOT_ID) : undefined
    if (sent === undefined) await sleep(2_000)
  }
  if (sent === undefined) {
    console.log(`[${LABEL}] SEND FAILED — no new human message appeared in the thread`)
    process.exit(2)
  }
  console.log(`[${LABEL}] wire message id=${sent.id} type=${sent.type} content=${JSON.stringify(sent.content ?? '')} author=${sent.author?.id} bot=${String(sent.author?.bot ?? false)}`)
  console.log(`[${LABEL}] wire attachments=${String((sent.attachments ?? []).length)} ` +
    JSON.stringify((sent.attachments ?? []).map(a => ({ filename: a.filename, content_type: a.content_type, size: a.size }))))

  // ── 2. What did DSH do? Observe new bot messages in the thread. ──
  const observed = new Map()
  const deadline = Date.now() + WAIT * 1000
  let stable = 0
  let prevCount = -1
  while (Date.now() < deadline) {
    const r = await rest('GET', `/channels/${THREAD}/messages?limit=30`)
    const fresh = Array.isArray(r.body)
      ? r.body.filter(m => isNew(m.id) && m.author?.id === BOT_ID)
      : []
    for (const m of fresh) observed.set(m.id, m.content ?? '')
    stable = fresh.length === prevCount ? stable + 1 : 0
    prevCount = fresh.length
    if (stable >= 3 && fresh.length > 0) break
    await sleep(4_000)
  }
  const rows = [...observed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  console.log(`[${LABEL}] DSH bot messages after send: ${rows.length}`)
  for (const [id, content] of rows.slice(0, 8)) console.log(`   - ${id} ${JSON.stringify(content.slice(0, 180))}`)

  // ── 3. Trace delta (windowed to this run's bytes) ──
  const delta = (await readFile(TRACE)).subarray(TRACE_OFFSET).toString('utf8')
  const lines = delta.split('\n').filter(l => l.includes('[dsh-discord:trace]'))
  const noise = /(\[dsh-discord:trace\] (frame|record|handle|raw-follow-frame|follow-|assistant))/
  const meaningful = lines.filter(l => !noise.test(l))
  console.log(`[${LABEL}] trace delta: ${lines.length} lines, ${meaningful.length} non-frame lines`)
  for (const line of meaningful.slice(0, 15)) console.log(`   | ${line.slice(0, 220)}`)

  console.log(`[${LABEL}] VERDICT: ${rows.length > 0 ? 'DSH REACTED (turn ran)' : 'DSH DID NOT REACT (no bot message, no turn)'}`)
}

main().catch(cause => { console.error(String(cause)); process.exit(2) })
