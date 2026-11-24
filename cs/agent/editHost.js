/**
 * editBridge.js 의 host 를 studio 창에 맞춰 만든다. studio 쪽 낮은 층(window.rhwpStudio.cs, cs/studio/embed-host.ts)이 만들어질 때까지
 * 기다렸다가 이어 붙인다. 메뉴줄 색(chrome)은 DOM 에서 읽는다.
 */

const TRANSPARENT = /^(transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/

/** #menu-bar 의 배경(투명이면 위로 올라가며 첫 불투명색)·글자·아래 테두리 색. 메뉴줄이 없으면 null */
export function readChrome(win, doc) {
  const el = doc.getElementById('menu-bar')
  if (!el) return null
  const cs = win.getComputedStyle(el)
  let bg = cs.backgroundColor
  for (let n = el.parentElement; n && TRANSPARENT.test(bg); n = n.parentElement) bg = win.getComputedStyle(n).backgroundColor
  if (TRANSPARENT.test(bg)) bg = win.getComputedStyle(doc.body).backgroundColor
  return { bg, fg: cs.color, border: cs.borderBottomColor }
}

export function createStudioHost({ win = window, doc = document, timeoutMs = 60000 } = {}) {
  const listeners = new Set()
  const fire = (e) => { for (const l of [...listeners]) { try { l(e) } catch { /* 듣는 쪽 오류는 무시 */ } } }
  let low = null

  const lowReady = new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      const c = win.rhwpStudio && win.rhwpStudio.cs
      if (c) return resolve(c)
      if (Date.now() - t0 > timeoutMs) return reject(new Error('studio 가 준비되지 않았습니다'))
      setTimeout(tick, 50)
    }
    tick()
  })

  const ready = lowReady.then(async (c) => {
    low = c
    c.on((e) => {
      if (e.event === 'dirty') fire({ event: 'dirty', dirty: !!e.dirty })
      else if (e.event === 'saveRequest') fire({ event: 'saveRequest' })
      else if (e.event === 'error') fire({ event: 'error', code: e.code, message: e.message })
    })
    // 테마가 바뀌면(스튜디오 설정·setTheme·시스템 설정) chrome 이벤트
    new win.MutationObserver(() => fire({ event: 'chrome' })).observe(doc.documentElement, {
      attributes: true, attributeFilter: ['data-theme-mode', 'data-theme-effective', 'data-theme-skin'],
    })
    await c.ready
  })

  const need = () => { if (!low) throw new Error('studio 가 아직 준비되지 않았습니다'); return low }
  return {
    ready,
    version: 'cs-embed-1',
    open: (name, u8) => need().open(name, u8),
    export: (format) => need().exportDocument(format),
    markSaved: () => need().markSaved(),
    state: () => (low ? low.state() : { loaded: false, dirty: false, name: null, ext: null }),
    setTheme: (t) => need().setTheme(t),
    getChrome: () => readChrome(win, doc),
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) },
  }
}
