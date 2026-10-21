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

  const before = await evaluate(`(() => {
    const items = document.querySelectorAll('[data-list-item-id]')
    return items.length === 0 ? '' : items[items.length - 1].getAttribute('data-list-item-id')
  })()`)

  await key({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })

  const started = Date.now()
  const deadline = started + 15_000
  let lastId = before
  let replyText = ''
  while (Date.now() < deadline) {
    await sleep(250)
    const state = await evaluate(`(() => {
      const items = document.querySelectorAll('[data-list-item-id]')
      if (items.length === 0) return null
      const last = items[items.length - 1]
      return { id: last.getAttribute('data-list-item-id'), text: (last.textContent ?? '').slice(0, 200) }
    })()`)
    if (state !== null && state.id !== before && state.id !== lastId) {
      lastId = state.id
      replyText = state.text
      break
    }
  }
  const elapsed = Date.now() - started
  ws.close()

  if (replyText === '') {
    console.log(`FAIL: no new message within ${String(elapsed)}ms — the interaction may have failed ("did not respond"?)`)
    process.exit(1)
  }
  const verdict = elapsed < 3_000 ? 'PASS (<3s budget)' : 'FAIL (over 3s budget)'
  console.log(`ack latency: ${String(elapsed)}ms — ${verdict}`)
  console.log(`reply (first 200 chars): ${replyText}`)
  process.exit(elapsed < 3_000 ? 0 : 1)
}

main().catch(cause => { console.error(String(cause)); process.exit(2) })
