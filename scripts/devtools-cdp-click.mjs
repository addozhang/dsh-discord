#!/usr/bin/env node
/**
 * CDP ephemeral-button clicker (2026-10-22). Clicks a button by EXACT
 * label anywhere in the anchored Discord tab — exact match matters
 * (AGENTS: stale ephemeral buttons stay clickable and near-duplicate
 * labels like "Confirm forget" vs "Confirm bind" must not cross-fire).
 *
 * Usage: node scripts/devtools-cdp-click.mjs 'Confirm bind' [--timeout 20000]
 * Exit 0 clicked / 1 not found / 2 CDP error. Prefer running promptly:
 * interaction tokens live ~15 minutes and ephemerals do not survive a
 * page refresh — the command that produced the button must run in the
 * SAME page session.
 */
import process from 'node:process'

const LABEL = process.argv[2]
const TIMEOUT = (() => { const i = process.argv.indexOf('--timeout'); return i > 0 ? Number(process.argv[i + 1]) : 20_000 })()
if (LABEL === undefined) { console.error('usage: devtools-cdp-click.mjs <exact button label>'); process.exit(2) }
const sleep = (ms) => new Promise(r => { setTimeout(r, ms) })

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(t => t.type === 'page' && t.url.includes('discord.com/channels/'))
if (page === undefined) { console.error('no discord.com/channels tab'); process.exit(2) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
}
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value

await send('Page.bringToFront')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })

const deadline = Date.now() + TIMEOUT
let result = null
while (Date.now() < deadline && result === null) {
  result = await evaluate(`(() => {
    const matches = [...document.querySelectorAll('button')]
      .filter(b => (b.textContent ?? '').trim() === ${JSON.stringify(LABEL)} && b.disabled !== true)
    if (matches.length === 0) return null
    // Prefer the LAST match: the newest ephemeral is at the bottom.
    matches[matches.length - 1].click()
    return 'clicked'
  })()`)
  if (result === null) await sleep(700)
}
ws.close()
if (result === 'clicked') {
  console.log(`clicked "${LABEL}"`)
  process.exit(0)
}
console.log(`button "${LABEL}" not found within ${String(TIMEOUT)}ms`)
process.exit(1)
