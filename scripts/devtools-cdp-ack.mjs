#!/usr/bin/env node
/**
 * CDP driver for real-machine interaction tests (2026-10-22).
 * Talks to the debug Chrome (scripts/devtools-chrome.sh) directly over
 * the DevTools protocol — no dependencies, Node's native WebSocket.
 *
 * Usage:
 *   node scripts/devtools-cdp-ack.mjs '/model show'
 *
 * Flow (AGENTS CDP 判例): anchor the discord.com/channels tab, force
 * focus, per-key keyDown the slash command (insertText does not trip
 * Discord's slash detection), submit, then poll the DOM for the ephemeral
 * reply and report the ack latency (Discord's budget is 3s; C-7).
 */
const COMMAND = process.argv[2] ?? '/model show'
const EXPECT = (() => { const i = process.argv.indexOf('--expect'); return i > 0 ? process.argv[i + 1] : undefined })()
const CDP_HTTP = 'http://127.0.0.1:9222'

const sleep = (ms) => new Promise(r => { setTimeout(r, ms) })

async function main() {
  const targets = await (await fetch(`${CDP_HTTP}/json`)).json()
  const page = targets.find(t => t.type === 'page' && t.url.includes('discord.com/channels/'))
  if (page === undefined) throw new Error('no discord.com/channels tab — open the guild first')
  console.log(`tab: ${page.url.slice(0, 70)}…`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return reply.result?.result?.value
  }

  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  // Focus the composer WITHOUT touching its internal model (AGENTS: DOM
  // edits to Slate desync — focus() only).
  const focused = await evaluate(`(() => {
    const box = document.querySelector('[role=textbox]')
    if (box === null) return false
    box.focus()
    return document.activeElement === box
  })()`)
  if (focused !== true) throw new Error('composer textbox not focusable')
  await sleep(400)

  const key = (k) => send('Input.dispatchKeyEvent', k)

  // A dirty composer silently corrupts the run: a stale slash pill left by a
  // previous stage gets merged into this command, the interaction never fires,
  // and the ack poll below then mistakes an unrelated re-render for the reply.
  // Clear it first, and abort loudly rather than measuring nothing.
  const composerText = () => evaluate(`(() => {
    const box = document.querySelector('[role=textbox]')
    return box === null ? '(no composer)' : (box.textContent ?? '').replace(/[\\u200b\\ufeff]/g, '')
  })()`)
  const pressKey = async (k, code, vk, modifiers = 0) => {
    await key({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
    await key({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  }
  if ((await composerText()) !== '') {
    await pressKey('Escape', 'Escape', 27) // dismiss the slash picker first
    await sleep(200)
    await pressKey('a', 'KeyA', 65, 4) // Cmd+A on the macOS debug Chrome
    await pressKey('Backspace', 'Backspace', 8)
    await sleep(200)
    for (let i = 0; i < 200 && (await composerText()) !== ''; i += 1) {
      await pressKey('Backspace', 'Backspace', 8)
      await sleep(30)
    }
    const leftover = await composerText()
    if (leftover !== '') {
      throw new Error(`composer would not clear (still ${JSON.stringify(leftover)}) — switch to another channel and back, then retry`)
    }
  }

  const typeChar = async (char) => {
    const upper = char.toUpperCase()
    await key({ type: 'keyDown', key: char, text: char, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), unmodifiedText: char })
    await key({ type: 'keyUp', key: char, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) })
    await sleep(35)
  }
  for (const char of COMMAND) {
    if (char === '/') {
      await key({ type: 'keyDown', key: '/', text: '/', code: 'Slash', windowsVirtualKeyCode: 191, unmodifiedText: '/' })
      await key({ type: 'keyUp', key: '/', code: 'Slash', windowsVirtualKeyCode: 191 })
      await sleep(250)
    } else if (char === ' ') {
      await key({ type: 'keyDown', key: ' ', text: ' ', code: 'Space', windowsVirtualKeyCode: 32, unmodifiedText: ' ' })
      await key({ type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
      await sleep(150)
    } else {
      await typeChar(char)
    }
  }
  await sleep(600)

  // Real messages only. [data-list-item-id] also tags date dividers
  // (chat-messages___divider-…) and thread cards (channels___…), so "the last
  // item changed" is a false ack — it fires on a re-render and reports a
  // sub-3s PASS for a command that never reached the bot. Pin to the channel's
  // own message ids instead.
  const lastMessage = () => evaluate(`(() => {
    const items = [...document.querySelectorAll('[data-list-item-id]')]
      .filter(node => /^chat-messages___chat-messages-\\d+-\\d+$/.test(node.getAttribute('data-list-item-id') ?? ''))
    if (items.length === 0) return null
    const last = items[items.length - 1]
    return { id: last.getAttribute('data-list-item-id'), text: (last.textContent ?? '').slice(0, 200) }
  })()`)

  const before = (await lastMessage())?.id ?? ''

  await key({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })

  const started = Date.now()
  const deadline = started + 15_000
  // Discord renders a command reply in stages: "Sending command…", then
  // "… is thinking", then the body. Only the last one is the ack we assert on.
  const PENDING = /Sending command|正在发送|is thinking|正在思考/
  let replyText = ''
  let elapsed = -1
  let resubmits = 0
  let stableText = ''
  let stableCount = 0
  while (Date.now() < deadline) {
    await sleep(250)
    // While the slash picker is open the first Enter only accepts the
    // highlighted command — it does not submit. Re-press (harmless when the
    // composer is already empty) instead of waiting out the whole budget.
    if (resubmits < 3 && (await composerText()) !== '') {
      resubmits += 1
      await key({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    }
    const state = await lastMessage()
    if (state === null || state.id === before) continue
    // The ack latency is when the entry APPEARS (the C-7 budget); the body is
    // filled in afterwards, sometimes under a NEW message id, so follow the
    // newest entry until it stops showing placeholders and stops changing.
    if (elapsed < 0) elapsed = Date.now() - started
    replyText = state.text
    if (PENDING.test(replyText)) {
      stableText = ''
      stableCount = 0
      continue
    }
    if (replyText === stableText) {
      stableCount += 1
      if (stableCount >= 2) break
    } else {
      stableText = replyText
      stableCount = 0
    }
  }
  if (elapsed < 0) elapsed = Date.now() - started
  ws.close()

  if (replyText === '') {
    console.log(`FAIL: no new message within ${String(elapsed)}ms — the interaction may have failed ("did not respond"?)`)
    process.exit(1)
  }
  // Still a placeholder when the budget ran out: the command was acknowledged
  // but never produced a body. Without this, a stuck "thinking…" entry passed
  // whenever no --expect was supplied (the suite runs without one).
  if (PENDING.test(replyText)) {
    console.log(`FAIL: reply stayed in a pending state (ack ${String(elapsed)}ms) — ${replyText.slice(0, 120)}`)
    process.exit(1)
  }
  const correlated = EXPECT === undefined ? true : replyText.includes(EXPECT)
  if (!correlated) console.log(`FAIL: reply lacked ${String(EXPECT)}`)
  const verdict = elapsed < 3_000 && correlated ? 'PASS (<3s budget)' : 'FAIL (over budget or uncorrelated)'
  console.log(`ack latency: ${String(elapsed)}ms — ${verdict}`)
  console.log(`reply (first 200 chars): ${replyText}`)
  process.exit(elapsed < 3_000 && correlated ? 0 : 1)
}

main().catch(cause => { console.error(String(cause)); process.exit(2) })
