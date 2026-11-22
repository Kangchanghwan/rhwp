import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHwpAgent } from './hwpAgent.js'
import { AGENT_METHODS } from './hwpAgentMethods.js'
import { installBridge, isAllowedParentOrigin, planToFn, resolveRefs, serializeError, collectTransfer, REMOTE_METHODS, EDIT_STEP_METHODS } from './bridge.js'
import { createAgentClient, recordEdit, reviveError, EDIT_STEP_METHODS as CLIENT_STEPS } from './client.js'
import { makeWindow, sample } from './testDoc.js'

const PARENT = 'http://localhost:5173'
const STUDIO = 'https://hwp.example.org'

/** 부모 창과 studio 창 한 쌍. postMessage 는 structured clone(+transfer) 후 비동기로 상대 창에 message 이벤트를 낸다 */
function windowPair({ parentOrigin = PARENT, studioOrigin = STUDIO } = {}) {
  const parent = new EventTarget()
  const frame = new EventTarget()
  frame.parent = parent
  parent.parent = parent
  const log = []
  const deliver = (to, from, fromOrigin) => (data, targetOrigin, transfer = []) => {
    log.push({ to: to === frame ? 'frame' : 'parent', data, targetOrigin, transfer })
    const cloned = structuredClone(data, { transfer })
    setTimeout(() => {
      const ev = new Event('message')
      Object.assign(ev, { data: cloned, origin: fromOrigin, source: from })
      to.dispatchEvent(ev)
    }, 0)
  }
  frame.postMessage = deliver(frame, parent, parentOrigin)
  parent.postMessage = deliver(parent, frame, studioOrigin)
  return { parent, frame, log }
}

let pair, doc, studioWin, env, agent, unbridge, client
beforeEach(() => {
  pair = windowPair()
  doc = sample()
  ;({ win: studioWin, env } = makeWindow(doc))
  agent = createHwpAgent(() => studioWin)
  unbridge = installBridge({ win: pair.frame, agent })
  client = createAgentClient({ getFrameWindow: () => pair.frame, origin: STUDIO, methods: AGENT_METHODS, win: pair.parent, ackTimeoutMs: 200 })
})
afterEach(() => { client.dispose(); unbridge() })

describe('부모 출처 허용 목록 (frame-ancestors 와 같음)', () => {
  it('허용', () => {
    for (const o of ['https://clipboardapp.org', 'https://www.clipboardapp.org', 'https://cs-git-x.vercel.app', 'https://a.b.vercel.app', 'http://localhost:5173', 'http://localhost', 'http://127.0.0.1:4173']) {
      expect(isAllowedParentOrigin(o), o).toBe(true)
    }
  })
  it('거절', () => {
    for (const o of ['https://evil.example', 'http://clipboardapp.org', 'https://clipboardapp.org.evil.example', 'https://vercel.app', 'https://x.vercel.app.evil.example',
      'https://localhost:5173', 'null', '', 'https://www.clipboardapp.org/', 'http://127.0.0.2:80', undefined]) {
      expect(isAllowedParentOrigin(o), String(o)).toBe(false)
    }
  })
})

describe('창구 (bridge + client)', () => {
  it('공개 함수 이름이 원래 hwpAgent 와 같다', () => {
    expect(Object.keys(client).filter((k) => k !== 'dispose').sort()).toEqual([...AGENT_METHODS].sort())
    expect(REMOTE_METHODS).not.toContain('guard')
    expect(CLIENT_STEPS).toEqual(EDIT_STEP_METHODS)
  })

  it('읽기·쓰기를 postMessage 로 대신 전한다', async () => {
    const o = await client.outline()
    expect(o.map((p) => p.text)).toEqual(['', '제목입니다', '본문 첫 줄', '', '', '끝'])
    const r = await client.replaceParagraph(2, '바뀐 본문', { expect: '본문 첫 줄' })
    expect(r).toBeTruthy()
    expect(doc.state.paras[2].text).toBe('바뀐 본문')
    const req = pair.log.find((m) => m.to === 'frame' && m.data.method === 'replaceParagraph')
    expect(req.data).toMatchObject({ cbHwpAgent: 1, method: 'replaceParagraph', args: [2, '바뀐 본문', { expect: '본문 첫 줄' }] })
    expect(req.targetOrigin).toBe(STUDIO)
    const res = pair.log.filter((m) => m.to === 'parent' && m.data.id === req.data.id)
    expect(res.map((m) => (m.data.ack ? 'ack' : m.data.ok))).toEqual(['ack', true])
    expect(res.every((m) => m.targetOrigin === PARENT)).toBe(true)
  })

  it('studio 오류는 code 와 추가 값을 그대로 돌려받는다', async () => {
    const err = await client.replaceParagraph(2, 'x', { expect: '다른 글' }).catch((e) => e)
    expect(err).toMatchObject({ name: 'HwpAgentError', code: 'EXPECT_MISMATCH', expected: '다른 글', actual: '본문 첫 줄' })
    expect(doc.state.paras[2].text).toBe('본문 첫 줄')
  })

  it('목록에 없는 함수는 거절한다', async () => {
    const id = 'x1'
    const got = new Promise((r) => pair.parent.addEventListener('message', (ev) => { if (ev.data.id === id && 'ok' in ev.data) r(ev.data) }))
    pair.frame.postMessage({ cbHwpAgent: 1, id, method: 'constructor', args: [] }, STUDIO)
    expect(await got).toMatchObject({ ok: false, error: { code: 'UNKNOWN_METHOD' } })
    const g = new Promise((r) => pair.parent.addEventListener('message', (ev) => { if (ev.data.id === 'x2' && 'ok' in ev.data) r(ev.data) }))
    pair.frame.postMessage({ cbHwpAgent: 1, id: 'x2', method: 'guard', args: [] }, STUDIO)
    expect(await g).toMatchObject({ ok: false, error: { code: 'UNKNOWN_METHOD' } })
  })

  it('허용하지 않은 출처나 부모가 아닌 창의 요청은 답하지 않는다', async () => {
    const bad = windowPair({ parentOrigin: 'https://evil.example' })
    const off = installBridge({ win: bad.frame, agent })
    const c = createAgentClient({ getFrameWindow: () => bad.frame, origin: STUDIO, methods: AGENT_METHODS, win: bad.parent, ackTimeoutMs: 100 })
    await expect(c.outline()).rejects.toMatchObject({ code: 'NO_AGENT' })
    expect(bad.log.filter((m) => m.to === 'parent')).toEqual([])
    c.dispose(); off()

    const stranger = new EventTarget()
    const ev = new Event('message')
    Object.assign(ev, { data: { cbHwpAgent: 1, id: 's', method: 'outline', args: [] }, origin: PARENT, source: stranger })
    pair.frame.dispatchEvent(ev)
    await new Promise((r) => setTimeout(r, 20))
    expect(pair.log.filter((m) => m.data.id === 's')).toEqual([])
  })

  it('다른 출처에서 온 응답은 받지 않는다 (client 는 studio 출처만 믿는다)', async () => {
    const c = createAgentClient({ getFrameWindow: () => pair.frame, origin: 'https://other.example', methods: AGENT_METHODS, win: pair.parent, ackTimeoutMs: 100 })
    await expect(c.outline()).rejects.toMatchObject({ code: 'NO_AGENT' })
    c.dispose()
  })

  it('창구가 없는 편집기면 NO_AGENT', async () => {
    unbridge()
    await expect(client.status()).rejects.toMatchObject({ code: 'NO_AGENT' })
  })

  it('edit: 기록한 묶음을 한 트랜잭션으로, 앞 결과를 다음 인자로', async () => {
    const before = env.txCount
    const res = await client.edit('묶음', (a) => {
      const p = a.insertParagraphAfter(2, '묶음 1')
      const q = a.insertParagraphAfter(p.i, '묶음 2')
      return { first: p.i, second: q.i }
    })
    expect(env.txCount - before).toBe(1)
    expect(res).toEqual({ first: 3, second: 4 })
    expect(doc.state.paras.slice(2, 5).map((x) => x.text)).toEqual(['본문 첫 줄', '묶음 1', '묶음 2'])
    await client.undo()
    expect(env.undone).toBe(1)
  })

  it('edit: 중간 실패는 전체 롤백', async () => {
    const n = doc.state.paras.length
    const err = await client.edit('실패', (a) => { a.insertParagraphAfter(2, '가'); a.replaceParagraph(99, 'x') }).catch((e) => e)
    expect(err.code).toBe('RANGE')
    expect(doc.state.paras.length).toBe(n)
  })

  it('edit: 결과로 계산하거나 async 함수면 보내기 전에 거절한다', async () => {
    const sent = pair.log.length
    await expect(client.edit('x', (a) => { const p = a.insertParagraphAfter(2, '가'); a.insertParagraphAfter(p.i + 1, '나') })).rejects.toMatchObject({ code: 'EDIT_REF' })
    await expect(client.edit('x', async () => {})).rejects.toMatchObject({ code: 'EDIT_ASYNC' })
    await expect(client.edit('x', () => { throw new Error('안에서 던짐') })).rejects.toThrow('안에서 던짐')
    expect(pair.log.length).toBe(sent)
  })

  it('guard: 이 페이지 작업을 돌리며 studio 대화상자를 지켜본다', async () => {
    expect(await client.guard(async () => 7)).toBe(7)
    studioWin.document = { querySelectorAll: () => [{ textContent: '저장 확인', closest: () => null }] }
    const err = await client.guard(() => new Promise(() => {}), { timeout: 5000 }).catch((e) => e)
    expect(err).toMatchObject({ code: 'DIALOG_BLOCKED', dialogs: ['저장 확인'] })
  })

  it('결과의 바이트는 transferable 로 넘긴다', async () => {
    const fake = { ...agent, check: async () => ({ bytes: new Uint8Array([1, 2, 3]) }) }
    unbridge()
    unbridge = installBridge({ win: pair.frame, agent: fake })
    const r = await client.check()
    expect(Array.from(r.bytes)).toEqual([1, 2, 3])
    const msg = pair.log.find((m) => m.to === 'parent' && m.data.ok === true)
    expect(msg.transfer.length).toBe(1)
  })
})

describe('도우미', () => {
  it('resolveRefs 는 자기 속성만 따라간다', () => {
    const results = [{ i: 3, cells: [['a']] }]
    expect(resolveRefs([{ $cbRef: 0, path: ['i'] }, { x: { $cbRef: 0, path: ['cells', 0, 0] } }], results)).toEqual([3, { x: 'a' }])
    expect(() => resolveRefs({ $cbRef: 1, path: [] }, results)).toThrow()
    expect(() => resolveRefs({ $cbRef: 0, path: ['__proto__'] }, results)).toThrow()
    expect(() => resolveRefs({ $cbRef: 0, path: ['constructor'] }, results)).toThrow()
  })
  it('planToFn 은 묶음 안 함수만 받는다', () => {
    expect(() => planToFn({ steps: [{ method: 'undo', args: [] }] })).toThrow()
    expect(() => planToFn({ steps: [{ method: 'outline', args: 'x' }] })).toThrow()
    expect(() => planToFn(null)).toThrow()
    expect(typeof planToFn({ steps: [{ method: 'outline', args: [] }], ret: null })).toBe('function')
  })
  it('recordEdit 은 함수 인자를 거절하고 결과 참조를 자리표로 바꾼다', () => {
    const plan = recordEdit((a) => { const t = a.insertTable(1, { rows: 2, cols: 2 }); a.deleteObject({ para: t.para, ctrlIdx: t.ctrlIdx }); return t })
    expect(plan).toEqual({ steps: [{ method: 'insertTable', args: [1, { rows: 2, cols: 2 }] }, { method: 'deleteObject', args: [{ para: { $cbRef: 0, path: ['para'] }, ctrlIdx: { $cbRef: 0, path: ['ctrlIdx'] } }] }], ret: { $cbRef: 0, path: [] } })
    expect(() => recordEdit((a) => { a.outline({ f: () => 1 }) })).toThrow()
    expect(() => recordEdit('x')).toThrow()
  })
  it('serializeError / reviveError', () => {
    const e = Object.assign(new Error('m'), { code: 'C', dialogs: ['a'], cause: new Error('c'), fn: () => 1 })
    const s = serializeError(e)
    expect(s).toEqual({ name: 'Error', message: 'm', code: 'C', dialogs: ['a'] })
    expect(structuredClone(s)).toEqual(s)
    const r = reviveError({ name: 'HwpAgentError', code: 'RANGE', message: 'x', count: 3 })
    expect(r).toBeInstanceOf(Error)
    expect(r).toMatchObject({ name: 'HwpAgentError', code: 'RANGE', message: 'x', count: 3 })
  })
  it('collectTransfer', () => {
    const u = new Uint8Array(4)
    const b = new ArrayBuffer(2)
    expect(collectTransfer({ a: [u, b], s: 'x' })).toEqual([u.buffer, b])
    expect(collectTransfer('x')).toEqual([])
  })
})
