/**
 * cbEdit v1: Clipboard Share(부모) <-> 한글 편집기(이 iframe) 창구. `?embed=cs` 로 열렸을 때만 켠다.
 *
 *   요청 (부모 -> 편집기): { cbEdit: 1, id, method, args }
 *   응답 (편집기 -> 부모): { cbEdit: 1, id, ok: true, result } | { cbEdit: 1, id, ok: false, error: { code, message } }
 *   이벤트 (편집기 -> 부모): { cbEdit: 1, event, ...data }   ready | chrome | dirty | saveRequest | error
 *   메서드: open({name, bytes}) | export({format?}) | markSaved() | state() | setTheme({theme})
 *
 * 기존 cbHwpAgent 창구(bridge.js)와는 메시지 표시(cbEdit / cbHwpAgent)로만 구분하며 서로 건드리지 않는다.
 * 편집기 쪽 실제 일은 `host` 가 한다(cs/studio/embed-host.ts 가 만든다). 이 파일은 DOM·엔진을 모르는 순수 창구라 단위 시험이 된다.
 *
 * host 계약
 *   ready: Promise            open 을 받을 수 있게 되면 이행
 *   version: string
 *   open(name, u8)  -> { pages }      실패하면 던진다
 *   export(format)  -> { bytes: Uint8Array, ext }  format 은 'hwp' | 'hwpx' | undefined(원래 형식)
 *   markSaved()
 *   state()  -> { loaded, dirty, name, ext }
 *   setTheme(theme)
 *   getChrome() -> { bg, fg, border }
 *   subscribe(cb)   cb({ event: 'dirty'|'chrome'|'saveRequest'|'error', ... }) 를 부른다. 해제 함수를 돌려준다
 */
import { isAllowedParentOrigin } from './bridge.js'

export const EDIT_METHODS = ['open', 'export', 'markSaved', 'state', 'setTheme']
export const ACCEPTS = ['hwp', 'hwpx']
const MIME = { hwp: 'application/x-hwp', hwpx: 'application/hwp+zip' }

class EditError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const bad = (code, message) => new EditError(code, message)

const isPlain = (v) => {
  if (!v || typeof v !== 'object') return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

const isRequest = (d) => isPlain(d) && d.cbEdit === 1 && typeof d.method === 'string' && typeof d.id === 'string' &&
  !own(d, 'ok') && !own(d, 'event')

const extOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

/** 부모 출처 후보: ancestorOrigins[0] 또는 referrer 의 origin (허용 목록에 맞을 때만) */
export function guessParentOrigin(win, doc, isAllowed = isAllowedParentOrigin) {
  const list = win.location && win.location.ancestorOrigins
  const a = list && list.length ? list[0] : null
  if (a && isAllowed(a)) return a
  try {
    const r = new URL((doc && doc.referrer) || '').origin
    if (r && r !== 'null' && isAllowed(r)) return r
  } catch { /* referrer 없음 */ }
  return null
}

/**
 * @param {{ win?: Window, doc?: Document, host: object, isAllowed?: (origin: string) => boolean, editor?: string }} o
 * @returns {{ dispose: () => void, ready: Promise<void> }}
 */
export function installEditBridge({ win = globalThis.window, doc = globalThis.document, host, isAllowed = isAllowedParentOrigin, editor = 'hwp' }) {
  let bound = null // 처음 받은 유효 요청의 출처
  let lastDirty = false
  let lastChrome = null
  let busy = false
  let disposed = false
  let readySent = false

  const parent = () => (win.parent && win.parent !== win ? win.parent : null)

  const emit = (msg, transfer = []) => {
    const p = parent()
    if (!p || disposed) return
    const target = bound || guessParentOrigin(win, doc, isAllowed) || '*'
    if (target === '*' && msg.event !== 'ready') return // 부모를 모르면 ready 말고는 보내지 않는다
    try { p.postMessage({ cbEdit: 1, ...msg }, target, transfer) } catch { /* 부모가 없어짐 */ }
  }

  const sendDirty = (dirty) => {
    dirty = !!dirty
    if (dirty === lastDirty) return
    lastDirty = dirty
    emit({ event: 'dirty', dirty })
  }
  const syncDirty = () => { try { sendDirty(host.state().dirty) } catch { /* 문서 없음 */ } }
  const sendChrome = () => {
    let c
    try { c = host.getChrome() } catch { return }
    if (!c) return
    const key = JSON.stringify(c)
    if (key === lastChrome) return
    lastChrome = key
    emit({ event: 'chrome', chrome: c })
  }

  const unsubscribe = host.subscribe((e) => {
    if (!readySent) return // ready 전에는 아무것도 보내지 않는다
    if (e.event === 'dirty') sendDirty(e.dirty)
    else if (e.event === 'chrome') sendChrome()
    else if (e.event === 'saveRequest') emit({ event: 'saveRequest' })
    else if (e.event === 'error') emit({ event: 'error', code: String(e.code || 'ENGINE_ERROR'), message: String(e.message || '') })
  })

  const methods = {
    async open(args) {
      if (!isPlain(args) || typeof args.name !== 'string') throw bad('OPEN_FAILED', 'open: { name, bytes } 가 필요합니다')
      const ext = extOf(args.name)
      if (!ACCEPTS.includes(ext)) throw bad('UNSUPPORTED', `지원하지 않는 확장자입니다: ${ext || '(없음)'}`)
      let u8
      if (args.bytes instanceof ArrayBuffer) u8 = new Uint8Array(args.bytes)
      else if (ArrayBuffer.isView(args.bytes)) u8 = new Uint8Array(args.bytes.buffer, args.bytes.byteOffset, args.bytes.byteLength)
      else throw bad('OPEN_FAILED', 'open: bytes 는 ArrayBuffer 여야 합니다')
      if (busy) throw bad('BUSY', '다른 작업을 처리 중입니다')
      busy = true
      try {
        let r
        try { r = await host.open(args.name, u8) } catch (e) { throw bad('OPEN_FAILED', String((e && e.message) || e)) }
        syncDirty() // 새 문서는 dirty=false 로 시작
        const out = {}
        if (r && Number.isFinite(r.pages)) out.pages = r.pages
        return out
      } finally { busy = false }
    },
    async export(args) {
      const a = args === undefined || args === null ? {} : args
      if (!isPlain(a)) throw bad('EXPORT_FAILED', 'export: 인자가 올바르지 않습니다')
      let format
      if (a.format !== undefined && a.format !== null) {
        format = String(a.format).toLowerCase()
        if (!ACCEPTS.includes(format)) throw bad('UNSUPPORTED', `지원하지 않는 형식입니다: ${a.format}`)
      }
      if (!host.state().loaded) throw bad('NO_DOCUMENT', '열린 문서가 없습니다')
      if (busy) throw bad('BUSY', '다른 작업을 처리 중입니다')
      let r
      try { r = await host.export(format) } catch (e) { throw bad('EXPORT_FAILED', String((e && e.message) || e)) }
      const u8 = r.bytes
      const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) // 복사본(transfer 용)
      return { bytes: buf, ext: r.ext, mime: MIME[r.ext] || 'application/octet-stream' }
    },
    async markSaved() {
      await host.markSaved()
      syncDirty()
      return {}
    },
    async state() {
      const s = host.state()
      return { loaded: !!s.loaded, dirty: !!s.dirty, name: s.name ?? null, ext: s.ext ?? null }
    },
    async setTheme(args) {
      const t = isPlain(args) ? args.theme : undefined
      if (t === 'light' || t === 'dark') {
        try { await host.setTheme(t) } catch { /* 지원 못 하면 그냥 {} */ }
        sendChrome()
      }
      return {}
    },
  }

  const onMessage = async (ev) => {
    const d = ev.data
    if (!isRequest(d)) return
    const p = parent()
    if (!p || ev.source !== p) return
    if (!isAllowed(ev.origin)) return
    if (bound && bound !== ev.origin) return
    bound = ev.origin
    const reply = (msg, transfer = []) => {
      try { p.postMessage({ cbEdit: 1, id: d.id, ...msg }, bound, transfer) } catch (e) {
        try { p.postMessage({ cbEdit: 1, id: d.id, ok: false, error: { code: 'INTERNAL', message: `결과를 보낼 수 없습니다: ${e && e.message}` } }, bound) } catch { /* 부모가 없어짐 */ }
      }
    }
    if (!own(methods, d.method) || !EDIT_METHODS.includes(d.method)) {
      reply({ ok: false, error: { code: 'UNKNOWN_METHOD', message: `알 수 없는 method: ${d.method}` } })
      return
    }
    try {
      const result = await methods[d.method](d.args)
      reply({ ok: true, result }, result && result.bytes instanceof ArrayBuffer ? [result.bytes] : [])
    } catch (e) {
      const code = e instanceof EditError ? e.code : 'INTERNAL'
      reply({ ok: false, error: { code, message: String((e && e.message) || e) } })
    }
  }
  win.addEventListener('message', onMessage)

  const ready = Promise.resolve(host.ready).then(() => {
    if (disposed) return
    let chrome = null
    try { chrome = host.getChrome() } catch { /* 메뉴줄 없음 */ }
    if (chrome) lastChrome = JSON.stringify(chrome)
    readySent = true
    emit({ event: 'ready', editor, version: String(host.version || ''), accepts: ACCEPTS.slice(), chrome })
  }).catch(() => {})

  return {
    ready,
    dispose() {
      disposed = true
      win.removeEventListener('message', onMessage)
      try { unsubscribe && unsubscribe() } catch { /* 이미 해제 */ }
    },
  }
}
