const GUILD = process.env.GUILD
const sleep = ms => new Promise(r => setTimeout(r, ms))
// Target channel: env CHANNEL_ID (default = keep current tab).
const CHANNEL = process.env.CHANNEL_ID
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(t => t.type === 'page' && t.url.includes('discord.com/channels/'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0; const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value
const key = k => send('Input.dispatchKeyEvent', k)
await send('Page.bringToFront'); await send('Emulation.setFocusEmulationEnabled', { enabled: true })
if (CHANNEL !== undefined && !page.url.includes(CHANNEL)) {
  await send('Page.navigate', { url: `https://discord.com/channels/${GUILD ?? ''}/${CHANNEL}` })
  await sleep(4_000)
}
await evaluate(`document.querySelector('[role=textbox]')?.focus()`); await sleep(400)
const type = async ch => {
  if (ch === ' ') { await key({ type:'keyDown', key:' ', text:' ', code:'Space', windowsVirtualKeyCode:32 }); await key({ type:'keyUp', key:' ', code:'Space', windowsVirtualKeyCode:32 }); await sleep(120) }
  else if (ch === '/') { await key({ type:'keyDown', key:'/', text:'/', code:'Slash', windowsVirtualKeyCode:191 }); await key({ type:'keyUp', key:'/', code:'Slash', windowsVirtualKeyCode:191 }); await sleep(250) }
  else { const u = ch.toUpperCase(); await key({ type:'keyDown', key:ch, text:ch, code:`Key${u}`, windowsVirtualKeyCode:u.charCodeAt(0) }); await key({ type:'keyUp', key:ch, code:`Key${u}`, windowsVirtualKeyCode:u.charCodeAt(0) }); await sleep(30) }
}
for (const ch of '/project bind ') await type(ch)
await sleep(1_200)
const rows = await evaluate(`[...document.querySelectorAll('[role=option]')].map(o => (o.textContent ?? '').trim()).filter(Boolean).slice(0, 8)`)
console.log('AUTOCOMPLETE ROWS:', JSON.stringify(rows))
// highlight index of the row containing 'fiber', navigate with ArrowDown, TAB to accept
const WANT = process.env.WORKSPACE ?? ''
const idx = Array.isArray(rows) && WANT !== '' ? rows.findIndex(r => r.includes(WANT)) : -1
console.log(`target row index: ${String(idx)} (WANT=${JSON.stringify(WANT)})`)
for (let i = 0; i < (idx > 0 ? idx : 0); i += 1) {
  await key({ type:'keyDown', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 })
  await key({ type:'keyUp', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 })
  await sleep(120)
}
await key({ type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 })
await key({ type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 })
await sleep(600)
await key({ type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 })
await key({ type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 })
console.log('submitted; waiting for response…'); await sleep(4_000)
const last = await evaluate(`(() => { const l = [...document.querySelectorAll('[data-list-item-id]')].at(-1); return (l?.textContent ?? '').slice(0, 300) })()`)
console.log('RESPONSE:', last.slice(0, 160))
// Click the confirm button if the flow reached it.
const deadline = Date.now() + 15000
let clicked = false
while (Date.now() < deadline && !clicked) {
  clicked = (await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /onfirm bind|确认绑定/i.test((b.textContent ?? '').trim()))
    if (btn === undefined) return false
    btn.click(); return true
  })()`)) === true
  if (!clicked) await sleep(700)
}
console.log(clicked ? 'CONFIRM CLICKED' : 'no confirm button (already bound or refused — see RESPONSE above)')
ws.close()
process.exit(clicked ? 0 : 1)
