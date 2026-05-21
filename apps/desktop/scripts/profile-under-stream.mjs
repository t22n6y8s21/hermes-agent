#!/usr/bin/env node
// Capture a CPU profile while the assistant is streaming AND the user is
// typing into the composer. This is the scenario most likely to feel laggy
// in real use: follow-up typing while a prior turn is still streaming in.
//
// Output: /tmp/hermes-stream-type.cpuprofile

import { writeFileSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).flatMap(s => {
    const m = s.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [[m[1], m[2] ?? true]] : []
  })
)
const PORT = Number(args.port ?? 9222)
const OUT = String(args.out ?? `/tmp/hermes-stream-type-${Date.now()}`)
const CHARS = Number(args.chars ?? 100)
const CPS = Number(args.cps ?? 20)

async function pickRenderer() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return list.find(t => t.type === 'page' && t.url.startsWith('http'))
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const myId = ++id
          ws.send(JSON.stringify({ id: myId, method, params }))
          return new Promise((res, rej) => pending.set(myId, { res, rej }))
        },
        close: () => ws.close()
      })
    )
    ws.addEventListener('error', reject)
    ws.addEventListener('message', ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8'))
      if (m.id != null) {
        const p = pending.get(m.id)
        if (!p) return
        pending.delete(m.id)
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
      }
    })
  })
}

async function evalP(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

async function main() {
  const tgt = await pickRenderer()
  console.log('target', tgt.url)
  const cdp = await connect(tgt.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Profiler.enable')

  // Submit a meaty prompt
  await evalP(
    cdp,
    `(() => {
      const el = document.querySelector('[data-slot="composer-rich-input"]')
      el.focus()
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r)
    })()`
  )
  const prompt = 'explain GPU memory bandwidth and the roofline model in detail with at least 6 paragraphs, no code'
  for (const c of prompt) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: c, unmodifiedText: c })
    await new Promise(r => setTimeout(r, 6))
  }
  await new Promise(r => setTimeout(r, 200))
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r'
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' })

  // Wait for stream to begin
  console.log('waiting for assistant…')
  let streaming = false
  for (let i = 0; i < 100; i++) {
    const c = await evalP(
      cdp,
      `document.querySelectorAll('[data-slot="aui_assistant-message-root"]').length`
    )
    if (c > 0) { streaming = true; break }
    await new Promise(r => setTimeout(r, 100))
  }
  if (!streaming) {
    console.error('no assistant message appeared')
    cdp.close()
    return
  }

  // Wait for stream to produce some tokens
  await new Promise(r => setTimeout(r, 800))

  // Refocus, start profiler, type while streaming
  await evalP(
    cdp,
    `(() => {
      const el = document.querySelector('[data-slot="composer-rich-input"]')
      el.focus()
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r)
    })()`
  )

  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
  await cdp.send('Profiler.start')

  const text = 'follow-up typing during streaming feels laggy when tokens flood in '.repeat(4).slice(0, CHARS)
  const intervalMs = Math.max(1, Math.round(1000 / CPS))
  const t0 = Date.now()
  for (let i = 0; i < text.length; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: text[i], unmodifiedText: text[i] })
    const expected = t0 + (i + 1) * intervalMs
    const wait = expected - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
  }
  await new Promise(r => setTimeout(r, 500))

  const { profile } = await cdp.send('Profiler.stop')
  writeFileSync(`${OUT}.cpuprofile`, JSON.stringify(profile))
  console.log(`cpuprofile → ${OUT}.cpuprofile`)

  // Quick top-self summary
  const total = (profile.endTime - profile.startTime) / 1000
  const intMs = total / Math.max(1, profile.samples?.length ?? 1)
  const counts = new Map()
  for (const s of profile.samples ?? []) counts.set(s, (counts.get(s) ?? 0) + 1)
  const rows = profile.nodes
    .map(n => ({ id: n.id, fn: n.callFrame.functionName || '(anon)', url: n.callFrame.url || '', line: n.callFrame.lineNumber, self: counts.get(n.id) ?? 0 }))
    .sort((a, b) => b.self - a.self)
    .slice(0, 25)
  console.log(`\n=== ${total.toFixed(0)}ms wall, ${profile.samples?.length ?? 0} samples (${intMs.toFixed(2)}ms each) ===`)
  for (const r of rows) {
    if (r.self === 0) break
    const url = r.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '').slice(0, 70)
    console.log(`  ${(r.self * intMs).toFixed(1).padStart(7)}ms  (${String(r.self).padStart(4)} samp)  ${r.fn.padEnd(45)} ${url}:${r.line}`)
  }

  // Cancel stream
  await evalP(
    cdp,
    `(() => {
      for (const b of document.querySelectorAll('button')) {
        if ((b.getAttribute('aria-label') || '').toLowerCase().includes('stop')) { b.click(); return 'stopped' }
      }
      return 'no-stop'
    })()`
  ).then(r => console.log('cancel:', r))

  cdp.close()
}

main().catch(e => {
  console.error('fatal:', e.stack ?? e.message)
  process.exit(1)
})
