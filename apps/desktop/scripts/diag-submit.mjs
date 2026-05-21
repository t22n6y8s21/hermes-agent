// Manual single-shot observer to find what's happening between Enter and clear
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const tgt = list.find(t => t.type === 'page' && t.url.startsWith('http'))
const ws = new WebSocket(tgt.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id != null && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise(r => ws.addEventListener('open', r))
const send = (m, p = {}) =>
  new Promise(r => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
const evalP = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result.result.value
}

// Type some text
const composerExists = await evalP(`
  (() => {
    const el = document.querySelector('[data-slot="composer-rich-input"]')
    if (!el) return false
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges(); sel.addRange(range)
    return true
  })()
`)
console.log('composer focused:', composerExists)

const text = 'cancel me ' + 'x'.repeat(30)
for (const c of text) {
  await send('Input.dispatchKeyEvent', { type: 'char', text: c, unmodifiedText: c })
  await new Promise(r => setTimeout(r, 10))
}
await new Promise(r => setTimeout(r, 200))

// Set up a deep observer that logs ALL state transitions in the composer subtree
await evalP(`
  (() => {
    window.__submitLog = []
    const composer = document.querySelector('[data-slot="composer-rich-input"]')
    const root = composer?.closest('[data-slot="composer-root"]') || document.body
    const startTime = performance.now()
    const log = (kind, detail) => window.__submitLog.push({ t: performance.now() - startTime, kind, detail })
    log('start', { composerText: composer?.innerText?.length || 0, hasDataAuiEmpty: composer?.hasAttribute('data-aui-composer-empty') })

    // Observe composer text changes via mutation
    const composerObs = new MutationObserver(muts => {
      const text = composer?.innerText ?? ''
      log('composerMut', { textLen: text.length, head: text.slice(0, 30) })
    })
    composer && composerObs.observe(composer, { childList: true, subtree: true, characterData: true })

    // Observe the busy state via aria-label / data-state on send button
    const sendBtn = document.querySelector('[aria-label*="end"]') || document.querySelector('[aria-label*="top"]')
    if (sendBtn) {
      const btnObs = new MutationObserver(() => {
        log('sendBtnMut', { aria: sendBtn.getAttribute('aria-label'), disabled: sendBtn.disabled })
      })
      btnObs.observe(sendBtn, { attributes: true })
      log('sendBtn', { aria: sendBtn.getAttribute('aria-label'), disabled: sendBtn.disabled })
    }

    // Observe thread message inserts
    const threadRoot = document.querySelector('[data-slot="aui_thread-content"]')
    const threadObs = threadRoot ? new MutationObserver(() => {
      const c = threadRoot.querySelectorAll('[data-slot="aui_message"], [data-message-role]').length
      log('threadMut', { count: c })
    }) : null
    threadObs && threadObs.observe(threadRoot, { childList: true, subtree: true })

    window.__obs = { composerObs, threadObs }
    return true
  })()
`)

// Hit Enter
console.log('pressing Enter…')
await send('Input.dispatchKeyEvent', {
  type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r'
})
await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' })

// Wait, then dump
await new Promise(r => setTimeout(r, 3500))

const logs = await evalP('JSON.stringify(window.__submitLog)')
console.log('\n=== EVENT LOG ===')
for (const e of JSON.parse(logs || '[]')) {
  console.log(`  ${String(e.t.toFixed(1)).padStart(7)}ms  ${e.kind.padEnd(15)} ${JSON.stringify(e.detail)}`)
}

// Cancel the pending agent turn
await evalP(`
  (() => {
    for (const b of document.querySelectorAll('button')) {
      if ((b.getAttribute('aria-label') || '').toLowerCase().includes('stop')) { b.click(); return 'stop-clicked' }
    }
    return 'no-stop'
  })()
`).then(r => console.log('cancel:', r))

ws.close()
