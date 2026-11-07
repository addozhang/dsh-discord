#!/usr/bin/env node
/**
 * Real-machine ask-flow driver (2026-11-07). Mentions the bot with a task that
 * forces an `ask_user_question`, waits for the rendered controls over REST,
 * then drives the Discord UI over CDP: opens the select, picks an entry, and
 * reports whether the custom-text modal actually appeared.
 *
 * This is the one check the twin cannot do — the twin accepts a MODAL callback
 * with no `title` (it only models 40060), while the real wire rejects it with a
 * 400 and drops the interaction, leaving a silently dead select (16.109).
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=... node scripts/devtools-cdp-ask.mjs "任务描述" \
 *     [--channel <id>] [--entry "Type your answer"] [--pre <option>] \
 *     [--answer <text>] [--expect modal|silent] [--trace /tmp/web-test-3081.log]
 *
 *   # Reuse controls a previous run already rendered (no mention is sent; the
 *   # task argument is then required but ignored, pass any placeholder):
 *   node scripts/devtools-cdp-ask.mjs x --thread <threadId> --entry Other --answer ...
 *
 * `--expect silent` is the baseline mode: it asserts the modal does NOT open,
 * which is what a dropped MODAL callback looks like (16.109).
 *
 * Exit 0 pass / 1 fail / 2 setup error.
 */
import process from 'node:process'
import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter(([k]) => k))
const TASK = process.argv[2] ?? '问我 2 个开放式问题，不要提供任何选项'
const GUILD = process.env.GUILD ?? '1562450757805146123'
const CHANNEL = args.channel ?? process.env.CHANNEL_ID ?? '1562614126172184586'
const ENTRY = args.entry ?? 'Type your answer'
const ANSWER = args.answer
const EXPECT = args.expect ?? 'modal'
const TRACE = args.trace
/** Reuse a thread whose ask controls were rendered by an earlier run. */
const THREAD = args.thread
/** Tick one more option before the entry (multi-select merge check). */
const PRE = args.pre
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? ''
const BOT_ID = '1550676723773739048'
const API = 'https://discord.com/api/v10'
const CDP = 'http://127.0.0.1:9222'
const sleep = ms => new Promise(r => { setTimeout(r, ms) })
const TRACE_OFFSET = TRACE === undefined ? 0 : statSync(TRACE).size

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
        key: params => send('Input.dispatchKeyEvent', params),
      })
    }
    ws.onerror = reject
  })
}

async function main() {
  if (TOKEN === '') throw new Error('DISCORD_BOT_TOKEN required')

  // ── 1. Send the mention (the last human trigger, automated) ──
  const targets = await (await fetch(`${CDP}/json`)).json()
  const page = targets.find(t => t.type === 'page' && t.url.includes('discord.com/channels/'))
  if (page === undefined) throw new Error('no discord.com/channels tab')
  const cdp = await connect(page)
  const { send, evaluate } = cdp
  const key = k => cdp.key(k)
  const typeChar = async char => {
    const upper = char.toUpperCase()
    await key({ type: 'keyDown', key: char, text: char, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), unmodifiedText: char })
    await key({ type: 'keyUp', key: char, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) })
    await sleep(30)
  }

  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  let threadId = THREAD ?? ''
  let preSendLastId = ''
  if (THREAD !== undefined) {
    console.log(`reusing thread ${THREAD} (no mention sent)`)
  } else {
    const channelUrl = `https://discord.com/channels/${GUILD}/${CHANNEL}`
    if (!page.url.includes(CHANNEL)) {
      await send('Page.navigate', { url: channelUrl })
      await sleep(4_000)
    }
    const focused = await evaluate(`(() => { const b = document.querySelector('[role=textbox]'); if (b === null) return false; b.focus(); return document.activeElement === b })()`)
    if (focused !== true) throw new Error('textbox not focusable')

    let options = []
    for (let attempt = 0; attempt < 4 && options.length === 0; attempt += 1) {
      await evaluate(`document.querySelector('[role=textbox]')?.focus()`)
      await sleep(500)
      await key({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await key({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await key({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await key({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      for (const char of '@dsh') await typeChar(char)
      await sleep(1_500)
      options = (await evaluate(`[...document.querySelectorAll('[role=option]')].map(o => (o.textContent ?? '').trim()).filter(Boolean).slice(0, 6)`)) ?? []
    }
    if (options.length === 0) throw new Error('mention autocomplete empty after "@dsh" retries')
    console.log(`autocomplete rows: ${options.join(' | ')}`)
    await key({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(500)
    for (const char of ` ${TASK}`) await typeChar(char)
    await sleep(300)
    preSendLastId = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-list-item-id]')]
        .filter(node => /^chat-messages___chat-messages-\\d+-\\d+$/.test(node.getAttribute('data-list-item-id') ?? ''))
      if (items.length === 0) return ''
      const parts = (items[items.length - 1].getAttribute('data-list-item-id') ?? '').split('-')
      return parts[parts.length - 1]
    })()`)
    await key({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    console.log('mention sent — switching to REST discovery')
  }

  // ── 2. Find this run's thread (mention mode only) ──
  const deadline = Date.now() + 240_000
  while (THREAD === undefined && Date.now() < deadline && threadId === '') {
    const active = await rest('GET', `/guilds/${GUILD}/threads/active`)
    const candidates = Array.isArray(active.body?.threads)
      ? active.body.threads.filter(t => t.parent_id === CHANNEL && (preSendLastId === '' || t.id > preSendLastId))
      : []
    candidates.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
    if (candidates[0] !== undefined) threadId = candidates[0].id
    if (threadId === '') await sleep(4_000)
  }
  check('mention → thread', threadId !== '', threadId)
  if (threadId === '') {
    cdp.ws.close()
    process.exit(1)
  }

  // ── 3. Wait for the ask controls (a message carrying components) ──
  let control = null
  while (Date.now() < deadline && control === null) {
    const msgs = await rest('GET', `/channels/${threadId}/messages?limit=50`)
    const withComponents = Array.isArray(msgs.body)
      ? msgs.body.filter(m => m.author?.id === BOT_ID && Array.isArray(m.components) && m.components.length > 0)
      : []
    const askMessage = withComponents.find(m => (m.components ?? []).some(row => (row.components ?? []).some(c => c.type === 3)))
    if (askMessage !== undefined) control = askMessage
    else await sleep(4_000)
  }
  check('ask controls rendered (string select on the wire)', control !== null, control?.id ?? 'none')
  if (control === null) {
    cdp.ws.close()
    process.exit(1)
  }
  const selectOptions = (control.components ?? [])
    .flatMap(row => row.components ?? [])
    .filter(c => c.type === 3)
    .flatMap(c => c.options ?? [])
    .map(o => o.label)
  console.log(`select options: ${selectOptions.join(' | ')}`)

  // ── 4. Drive the UI: open the select, pick the entry ──
  await send('Page.navigate', { url: `https://discord.com/channels/${GUILD}/${threadId}` })
  await sleep(4_000)
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  const opened = await evaluate(`(async () => {
    const target = await (async () => {
      for (let i = 0; i < 30; i++) {
        const node = [...document.querySelectorAll('[data-list-item-id]')]
          .find(n => (n.getAttribute('data-list-item-id') ?? '').endsWith('-${control.id}'))
        if (node !== undefined) return node
        const scroller = document.querySelector('[class*="scroller"]')
        if (scroller !== null) scroller.scrollTop = scroller.scrollHeight
        await new Promise(r => setTimeout(r, 300))
      }
      return null
    })()
    if (target === null) return { error: 'message-node-missing' }
    target.scrollIntoView({ block: 'center' })
    await new Promise(r => setTimeout(r, 400))
    const trigger = target.querySelector('[aria-haspopup="listbox"]')
      ?? [...target.querySelectorAll('[role="button"]')].find(b => /select|选择/i.test(b.textContent ?? ''))
    if (trigger === undefined) return { error: 'select-trigger-missing' }
    // A retired control greys out (aria-disabled="true"): clicking it does
    // nothing, which is indistinguishable from the 400 drop we are hunting.
    if (trigger.getAttribute('aria-disabled') === 'true' || trigger.getAttribute('aria-disabled') === '') {
      return { error: 'select-control-retired' }
    }
    trigger.click()
    return { clicked: true }
  })()`)
  if (opened?.clicked !== true) {
    check('select menu opens', false, JSON.stringify(opened))
    cdp.ws.close()
    process.exit(1)
  }

  if (PRE !== undefined) {
    const prePicked = await evaluate(`(async () => {
      for (let i = 0; i < 30; i++) {
        const hit = [...document.querySelectorAll('[role="option"]')]
          .find(o => (o.textContent ?? '').includes(${JSON.stringify(PRE)}))
        if (hit !== undefined) { hit.click(); return true }
        await new Promise(r => setTimeout(r, 150))
      }
      return false
    })()`)
    check(`pre-selection "${PRE}" ticked`, prePicked === true)
    await sleep(400)
  }

  const picked = await evaluate(`(async () => {
    for (let i = 0; i < 30; i++) {
      const hit = [...document.querySelectorAll('[role="option"]')]
        .find(o => (o.textContent ?? '').includes(${JSON.stringify(ENTRY)}))
      if (hit !== undefined) { hit.click(); return true }
      await new Promise(r => setTimeout(r, 150))
    }
    return false
  })()`)
  check(`entry "${ENTRY}" picked`, picked === true)

  // A multi-select popout stays open after ticking (the user may tick more);
  // the interaction only fires once it closes, so click outside it.
  if (picked === true) {
    await sleep(700)
    const alreadyOpen = await evaluate(`document.querySelector('[role="dialog"]') !== null`)
    if (alreadyOpen !== true) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 })
      await sleep(1_500)
    }
  }

  // ── 5. Did the modal actually appear? ──
  const modal = await evaluate(`(async () => {
    for (let i = 0; i < 40; i++) {
      const dialog = document.querySelector('[role="dialog"]')
      if (dialog !== null) return (dialog.textContent ?? '').slice(0, 120)
      await new Promise(r => setTimeout(r, 150))
    }
    return null
  })()`)
  const modalVisible = modal !== null
  check(`modal ${EXPECT === 'modal' ? 'appears' : 'stays closed'}`, EXPECT === 'modal' ? modalVisible : !modalVisible, modal === null ? 'no dialog' : modal.slice(0, 60))

  // ── 6. Optionally answer inside the modal ──
  if (ANSWER !== undefined && modalVisible) {
    await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const input = dialog?.querySelector('textarea, [contenteditable="true"]')
      if (input === null || input === undefined) return false
      input.focus()
      return true
    })()`)
    await send('Input.insertText', { text: ANSWER })
    await sleep(400)
    const submitted = await evaluate(`(async () => {
      const dialog = document.querySelector('[role="dialog"]')
      const button = [...(dialog?.querySelectorAll('button') ?? [])]
        .find(b => /submit|提交/i.test(b.textContent ?? '') && b.disabled !== true)
      if (button === undefined) return false
      button.click()
      return true
    })()`)
    check('modal answer submitted', submitted === true)
    await sleep(1_500)

    // The modal only writes a draft. Until the submit row is pressed the batch
    // stays pending and the host keeps waiting — a run that stops here proves
    // the modal opens and nothing more.
    const rowClicked = await evaluate(`(async () => {
      const node = [...document.querySelectorAll('[data-list-item-id]')]
        .find(n => (n.getAttribute('data-list-item-id') ?? '').endsWith('-${control.id}'))
      if (node === undefined) return 'no-node'
      const button = [...node.querySelectorAll('[role="button"]')]
        .find(b => /submit answers|提交/i.test(b.textContent ?? ''))
      if (button === undefined) return 'no-submit-row'
      if (button.getAttribute('aria-disabled') === 'true' || button.disabled === true) return 'already-retired'
      button.click()
      return 'clicked'
    })()`)
    check('submit row pressed', rowClicked === 'clicked' || rowClicked === 'no-submit-row', rowClicked)

    // Settlement is observable on the wire: retire disables every control.
    // (Asserting on thread prose is a trap — the prompt itself contains
    // "answers stay editable until you submit", which every naive /answers/
    // matcher reports as an acknowledgement.)
    let settled = false
    const settleBy = Date.now() + 30_000
    while (Date.now() < settleBy && !settled) {
      const one = await rest('GET', `/channels/${threadId}/messages/${control.id}`)
      const controls = (one.body?.components ?? []).flatMap(row => row.components ?? [])
      settled = controls.length > 0 && controls.every(c => c.disabled === true)
      if (!settled) await sleep(2_000)
    }
    check('ask batch settled (every control retired)', settled)

    // The real end-to-end signal: the host picks the session back up and posts
    // something after the ask. Without this the answer never left the store.
    let resumed = ''
    const resumeBy = Date.now() + 45_000
    while (Date.now() < resumeBy && resumed === '') {
      const after = await rest('GET', `/channels/${threadId}/messages?limit=20`)
      const followUp = (Array.isArray(after.body) ? after.body : [])
        .filter(m => m.author?.id === BOT_ID && BigInt(m.id) > BigInt(control.id) && (m.content ?? '').trim() !== '')
      if (followUp.length > 0) resumed = followUp[0].content.trim()
      else await sleep(3_000)
    }
    check('session resumed (host posted after the answer)', resumed !== '', resumed.slice(0, 100))
  }

  if (TRACE !== undefined) {
    // Only real adapter log lines count: the trace stream also echoes every
    // host event, and any session that talks ABOUT these events would
    // otherwise trip the scan (observed: an agent conversation quoting
    // "discord_question_modal_failed" in a bash command).
    const raw = await readFile(TRACE)
    const logLines = raw.subarray(TRACE_OFFSET).toString('utf8')
      .split('\n')
      .filter(line => line.startsWith('[dsh-discord]'))
    const failures = logLines.filter(line => /_(failed|threw|blocked)\b/.test(line))
    check('trace hygiene: zero failure-shaped events', failures.length === 0, failures.slice(0, 3).join(' | '))
    const modalFail = logLines.filter(line => line.includes('discord_question_modal_failed'))
    check('no modal-callback refusal logged', modalFail.length === 0, modalFail.slice(0, 2).join(' | '))
  }

  cdp.ws.close()
  console.log(failed === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${String(failed)})`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(cause => { console.error(String(cause)); process.exit(2) })
