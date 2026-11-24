import { describe, it, expect, afterEach } from 'vitest'
import { installEditBridge, guessParentOrigin } from './editBridge.js'
import { readChrome } from './editHost.js'

const PARENT = 'http://localhost:5173'
const STUDIO = 'https://hwp.example.org'
const tick = () => new Promise((r) => setTimeout(r, 5))

function windowPair({ parentOrigin = PARENT } = {}) {
  const parent = new EventTarget()
  const frame = new EventTarget()
  frame.parent = parent
  parent.parent = parent
  frame.location = { ancestorOrigins: [] }
  const toParent = [] // 편집기가 부모로 보낸 것
  const mk = (to, from, fromOrigin, log) => (data, targetOrigin, transfer = []) => {
    log?.push({ data, targetOrigin, transfer })
    const cloned = structuredClone(data, { transfer })
    setTimeout(() => {
      const ev = new Event('message')
      Object.assign(ev, { data: cloned, origin: fromOrigin, source: from })
      to.dispatchEvent(ev)
    }, 0)
  }
  frame.postMessage = mk(frame, parent, parentOrigin)
  parent.postMessage = mk(parent, frame, STUDIO, toParent)
  const got = []
  parent.addEventListener('message', (ev) => got.push(ev.data))
  const call = async (method, args, id = `i${got.length}-${method}`) => {
    frame.postMessage({ cbEdit: 1, id, method, args }, STUDIO)
    for (let i = 0; i < 200; i++) { await tick(); const r = got.find((m) => m.id === id); if (r) return r }
    throw new Error('응답 없음 ' + method)
  }
  return { parent, frame, got, toParent, call, events: (n) => got.filter((m) => m.event === n) }
}

function fakeHost() {
  const subs = new Set()
  const st = { loaded: false, dirty: false, name: null, ext: null }
  const host = {
    ready: Promise.resolve(),
    version: 'v-test',
    st,
    emit: (e) => subs.forEach((s) => s(e)),
    chrome: { bg: 'rgb(1, 2, 3)', fg: 'rgb(4, 5, 6)', border: 'rgb(7, 8, 9)' },
    calls: [],
    async open(name, u8) { host.calls.push(['open', name, u8.length]); if (name.startsWith('broken')) throw new Error('파싱 실패'); Object.assign(st, { loaded: true, dirty: false, name, ext: name.split('.').pop() }); return { pages: 3 } },
    async export(format) { const ext = format || st.ext; host.calls.push(['export', ext]); return { bytes: new Uint8Array([1, 2, 3, 4]), ext } },
    async markSaved() { st.dirty = false; host.emit({ event: 'dirty', dirty: false }) },
    state: () => ({ ...st }),
    async setTheme(t) { host.chrome = t === 'dark' ? { bg: 'rgb(0, 0, 0)', fg: '#fff', border: '#333' } : host.chrome },
    getChrome: () => host.chrome,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
  }
  return host
}

let bridge
afterEach(() => { bridge?.dispose(); bridge = null })
const setup = (o = {}, hostOver = {}) => {
  const w = windowPair(o)
  const host = Object.assign(fakeHost(), hostOver)
  bridge = installEditBridge({ win: w.frame, doc: { referrer: `${PARENT}/page` }, host })
  return { ...w, host }
}

describe('ready', () => {
  it('open 을 받을 수 있게 되면 한 번 보내고, referrer 의 출처로 보낸다', async () => {
    const w = setup()
    await bridge.ready; await tick(); await tick()
    const ready = w.events('ready')
    expect(ready).toHaveLength(1)
    expect(ready[0]).toMatchObject({ cbEdit: 1, editor: 'hwp', version: 'v-test', accepts: ['hwp', 'hwpx'], chrome: { bg: 'rgb(1, 2, 3)', fg: 'rgb(4, 5, 6)', border: 'rgb(7, 8, 9)' } })
    expect(w.toParent[0].targetOrigin).toBe(PARENT)
  })
  it('부모를 알 수 없으면 ready 만 * 로 보낸다', async () => {
    const w = windowPair()
    const host = fakeHost()
    bridge = installEditBridge({ win: w.frame, doc: { referrer: '' }, host })
    await bridge.ready; await tick()
    expect(w.toParent[0].targetOrigin).toBe('*')
    host.emit({ event: 'saveRequest' })
    await tick()
    expect(w.toParent).toHaveLength(1) // 부모를 모르는 동안 다른 이벤트는 보내지 않는다
  })
  it('ancestorOrigins 가 허용 목록이면 우선 쓴다', () => {
    const win = { location: { ancestorOrigins: ['https://clipboardapp.org'] } }
    expect(guessParentOrigin(win, { referrer: 'http://localhost:1/x' })).toBe('https://clipboardapp.org')
    expect(guessParentOrigin({ location: { ancestorOrigins: ['https://evil.example'] } }, { referrer: '' })).toBe(null)
  })
})

describe('보안', () => {
  it('허용 목록 밖 출처·부모가 아닌 창의 요청은 무시한다', async () => {
    const w = setup({ parentOrigin: 'https://evil.example' })
    const r = await Promise.race([w.call('state', {}, 'x1'), new Promise((r) => setTimeout(() => r('none'), 80))])
    expect(r).toBe('none')
    const ev = new Event('message')
    Object.assign(ev, { data: { cbEdit: 1, id: 'x2', method: 'state', args: {} }, origin: PARENT, source: new EventTarget() })
    w.frame.dispatchEvent(ev)
    await tick(); await tick()
    expect(w.got.find((m) => m.id === 'x2')).toBeUndefined()
  })
  it('처음 받은 요청의 출처에 묶인다', async () => {
    const w = setup()
    expect((await w.call('state', {})).ok).toBe(true)
    expect(w.toParent.at(-1).targetOrigin).toBe(PARENT)
    // 다른 허용 출처가 나중에 요청해도 받지 않는다
    const ev = new Event('message')
    Object.assign(ev, { data: { cbEdit: 1, id: 'y', method: 'state' }, origin: 'https://clipboardapp.org', source: w.parent })
    w.frame.dispatchEvent(ev)
    await tick(); await tick()
    expect(w.got.find((m) => m.id === 'y')).toBeUndefined()
  })
  it('cbHwpAgent 메시지와 모양이 다른 메시지는 건드리지 않는다', async () => {
    const w = setup()
    w.frame.postMessage({ cbHwpAgent: 1, id: 'a', method: 'outline' }, STUDIO)
    w.frame.postMessage({ cbEdit: 1, id: 5, method: 'state' }, STUDIO)
    await tick(); await tick()
    expect(w.got.filter((m) => m.id === 'a' || m.id === 5)).toHaveLength(0)
  })
  it('알 수 없는 method', async () => {
    const w = setup()
    expect((await w.call('constructor', {})).error.code).toBe('UNKNOWN_METHOD')
    expect((await w.call('guard', {})).error.code).toBe('UNKNOWN_METHOD')
  })
})

describe('open / export / state', () => {
  it('open: 확장자 검사, 쪽 수, dirty=false', async () => {
    const w = setup()
    const bytes = new Uint8Array([9, 9, 9]).buffer
    const r = await w.call('open', { name: '가.HWPX', bytes })
    expect(r).toMatchObject({ ok: true, result: { pages: 3 } })
    expect(w.host.calls[0]).toEqual(['open', '가.HWPX', 3])
    expect((await w.call('open', { name: 'a.docx', bytes })).error.code).toBe('UNSUPPORTED')
    expect((await w.call('open', { name: 'broken.hwp', bytes })).error.code).toBe('OPEN_FAILED')
    expect((await w.call('open', { name: 'a.hwp', bytes: 'x' })).error.code).toBe('OPEN_FAILED')
  })
  it('open 은 겹치면 BUSY', async () => {
    let release
    const w = setup({}, { open: () => new Promise((r) => { release = () => r({ pages: 1 }) }) })
    const bytes = new Uint8Array(2).buffer
    const first = w.call('open', { name: 'a.hwp', bytes }, 'o1')
    await tick(); await tick()
    expect((await w.call('open', { name: 'b.hwp', bytes }, 'o2')).error.code).toBe('BUSY')
    release()
    expect((await first).ok).toBe(true)
  })
  it('export: 원래 형식, 지정 형식, ext·mime, 바이트는 transfer', async () => {
    const w = setup()
    expect((await w.call('export', {})).error.code).toBe('NO_DOCUMENT')
    await w.call('open', { name: 'a.hwp', bytes: new Uint8Array(1).buffer })
    const r1 = await w.call('export', {})
    expect(r1.result.ext).toBe('hwp')
    expect(r1.result.mime).toBe('application/x-hwp')
    expect(Array.from(new Uint8Array(r1.result.bytes))).toEqual([1, 2, 3, 4])
    const r2 = await w.call('export', { format: 'HWPX' })
    expect(r2.result).toMatchObject({ ext: 'hwpx', mime: 'application/hwp+zip' })
    expect(w.toParent.find((m) => m.data.id === r2.id).transfer).toHaveLength(1)
    expect((await w.call('export', { format: 'docx' })).error.code).toBe('UNSUPPORTED')
    expect((await w.call('export', undefined)).ok).toBe(true)
  })
  it('export 실패는 EXPORT_FAILED', async () => {
    const w = setup({}, { async export() { throw new Error('엔진 오류') } })
    await w.call('open', { name: 'a.hwp', bytes: new Uint8Array(1).buffer })
    expect((await w.call('export', {})).error.code).toBe('EXPORT_FAILED')
  })
  it('state', async () => {
    const w = setup()
    expect((await w.call('state', {})).result).toEqual({ loaded: false, dirty: false, name: null, ext: null })
    await w.call('open', { name: 'a.hwpx', bytes: new Uint8Array(1).buffer })
    expect((await w.call('state', {})).result).toEqual({ loaded: true, dirty: false, name: 'a.hwpx', ext: 'hwpx' })
  })
})

describe('이벤트', () => {
  it('dirty: 같은 값은 반복하지 않고, open 은 false 로 시작, markSaved 는 false', async () => {
    const w = setup()
    await bridge.ready; await tick()
    await w.call('open', { name: 'a.hwp', bytes: new Uint8Array(1).buffer })
    w.host.st.dirty = true
    w.host.emit({ event: 'dirty', dirty: true })
    w.host.emit({ event: 'dirty', dirty: true })
    w.host.emit({ event: 'dirty', dirty: true })
    await tick(); await tick()
    expect(w.events('dirty').map((e) => e.dirty)).toEqual([true])
    expect((await w.call('markSaved', {})).result).toEqual({})
    await tick()
    expect(w.events('dirty').map((e) => e.dirty)).toEqual([true, false])
    w.host.st.dirty = true; w.host.emit({ event: 'dirty', dirty: true })
    await w.call('open', { name: 'b.hwp', bytes: new Uint8Array(1).buffer }) // 새 문서로 바뀌면 false 가 따라간다
    await tick()
    expect(w.events('dirty').map((e) => e.dirty)).toEqual([true, false, true, false])
  })
  it('saveRequest · error 를 전달한다', async () => {
    const w = setup()
    await bridge.ready; await tick()
    await w.call('state', {}) // 부모 출처에 묶는다
    w.host.emit({ event: 'saveRequest' })
    w.host.emit({ event: 'error', code: 'ENGINE_BLOCKED', message: '막힘' })
    await tick(); await tick()
    expect(w.events('saveRequest')).toHaveLength(1)
    expect(w.events('error')[0]).toMatchObject({ code: 'ENGINE_BLOCKED', message: '막힘' })
  })
  it('setTheme: chrome 이 바뀌면 chrome 이벤트, 같으면 보내지 않는다', async () => {
    const w = setup()
    await bridge.ready; await tick()
    await w.call('state', {})
    expect((await w.call('setTheme', { theme: 'dark' })).result).toEqual({})
    expect((await w.call('setTheme', { theme: 'dark' })).result).toEqual({})
    expect((await w.call('setTheme', { theme: 'pink' })).result).toEqual({})
    await tick()
    expect(w.events('chrome')).toHaveLength(1)
    expect(w.events('chrome')[0].chrome.bg).toBe('rgb(0, 0, 0)')
  })
})

describe('readChrome', () => {
  it('투명한 배경은 위 요소의 색을 쓴다', () => {
    const styles = new Map()
    const body = { parentElement: null }
    const root = { parentElement: null }
    const bar = { parentElement: root }
    styles.set(bar, { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'red', borderBottomColor: 'blue' })
    styles.set(root, { backgroundColor: 'rgb(9, 9, 9)' })
    const win = { getComputedStyle: (e) => styles.get(e) }
    expect(readChrome(win, { getElementById: () => bar, body })).toEqual({ bg: 'rgb(9, 9, 9)', fg: 'red', border: 'blue' })
    expect(readChrome(win, { getElementById: () => null, body })).toBe(null)
  })
})
