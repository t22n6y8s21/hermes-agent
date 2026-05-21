#!/usr/bin/env node
// Measure typing latency WHILE the assistant is streaming a response.
// Submits a prompt, then immediately starts typing into the composer
// while tokens stream in. Records keypress→paint latency under load.
//
// Usage: node apps/desktop/scripts/latency-under-stream.mjs --chars=120 --cps=20

import { writeFileSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).flatMap(s => {
    const m = s.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [[m[1], m[2] ?? true]] : []
  })
)
const PORT = Number(args.port ?? 9222)
const CHARS = Number(args.chars ?? 120)
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

  // 1) Type a prompt + Enter
  await evalP(
    cdp,
    `(() => {
      const el = document.querySelector('[data-slot="composer-rich-input"]')
      el.focus()
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r)
    })()`
  )

  const prompt = 'write a short technical explanation of WebGL2 fragment shaders, just a paragraph please'
  for (const c of prompt) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: c, unmodifiedText: c })
    await new Promise(r => setTimeout(r, 8))
  }
  await new Promise(r => setTimeout(r, 200))

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r'
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' })

  // 2) Wait for the assistant to actually start streaming (look for streaming indicator)
  console.log('waiting for stream to start…')
  const streamStarted = await (async () => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const text = await evalP(
        cdp,
        `(() => {
          // Look for either streaming indicator OR new assistant message
          const aiMsgs = document.querySelectorAll('[data-slot="aui_assistant-message-root"], [data-role="assistant"]')
          return aiMsgs.length > 0 ? 'started' : null
        })()`
      )
      if (text === 'started') return true
      await new Promise(r => setTimeout(r, 100))
    }
    return false
  })()
  console.log('stream started:', streamStarted)

  if (!streamStarted) {
    console.log('no streaming detected; aborting')
    cdp.close()
    return
  }

  // Wait a moment to ensure stream is actively producing tokens
  await new Promise(r => setTimeout(r, 800))

  // 3) Refocus composer + install latency observer
  await evalP(
    cdp,
    `(() => {
      const el = document.querySelector('[data-slot="composer-rich-input"]')
      if (!el) return false
      el.focus()
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r)
      window.__keypressTimings = []
      window.__pendingKey = null
      const obs = new MutationObserver(() => {
        const start = window.__pendingKey
        if (start === null) return
        const mut = performance.now()
        window.__pendingKey = null
        requestAnimationFrame(() => {
          window.__keypressTimings.push({
            start, mut, paint: performance.now(),
            mutLat: mut - start, paintLat: performance.now() - start
          })
        })
      })
      obs.observe(el, { childList: true, subtree: true, characterData: true })
      window.__keystrokeObserver = obs
      return true
    })()`
  )

  // 4) Type while streaming
  const text =
    'meanwhile typing into the composer while streaming runs — ' +
    'how does this feel as the assistant streams tokens above? '
  const slice = text.slice(0, CHARS)
  const intervalMs = Math.max(1, Math.round(1000 / CPS))
  const t0 = Date.now()
  for (let i = 0; i < slice.length; i++) {
    await evalP(cdp, `window.__pendingKey = performance.now()`)
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: slice[i], unmodifiedText: slice[i] })
    const expected = t0 + (i + 1) * intervalMs
    const wait = expected - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
  }
  await new Promise(r => setTimeout(r, 500))

  // 5) Pull samples
  const samples = await evalP(cdp, `JSON.stringify(window.__keypressTimings || [])`)
  const arr = JSON.parse(samples)
  console.log(`\n${arr.length} keystroke samples taken while streaming`)

  const paintLat = arr.map(s => s.paintLat).sort((a, b) => a - b)
  const mutLat = arr.map(s => s.mutLat).sort((a, b) => a - b)
  const stat = a => ({
    n: a.length,
    min: a[0]?.toFixed(2),
    p50: a[Math.floor(a.length * 0.5)]?.toFixed(2),
    p90: a[Math.floor(a.length * 0.9)]?.toFixed(2),
    p95: a[Math.floor(a.length * 0.95)]?.toFixed(2),
    p99: a[Math.floor(a.length * 0.99)]?.toFixed(2),
    max: a[a.length - 1]?.toFixed(2),
    mean: a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : 0
  })
  console.log('\n=== keystroke→mutation latency (ms) while streaming ===')
  console.log(' ', stat(mutLat))
  console.log('\n=== keystroke→paint latency (ms) while streaming ===')
  console.log(' ', stat(paintLat))
  const slow = arr.filter(s => s.paintLat > 16).length
  console.log(`\n${slow}/${arr.length} keystrokes > 16ms (dropped frame) while streaming`)

  // 6) Cancel the stream
  await evalP(
    cdp,
    `(() => {
      for (const b of document.querySelectorAll('button')) {
        if ((b.getAttribute('aria-label') || '').toLowerCase().includes('stop')) { b.click(); return 'stopped' }
      }
      return 'no-stop'
    })()`
  ).then(r => console.log('cancel:', r))

  writeFileSync('/tmp/hermes-latency-under-stream.json', JSON.stringify(arr, null, 2))
  cdp.close()
}

main().catch(e => {
  console.error('fatal:', e.stack ?? e.message)
  process.exit(1)
})
