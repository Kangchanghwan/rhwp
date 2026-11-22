/**
 * studio 창 안에서 부모 페이지(Clipboard Share)의 에이전트 요청을 받는 창구.
 *
 *   요청 (부모 -> studio): { cbHwpAgent: 1, id, method, args }
 *   받음 (studio -> 부모): { cbHwpAgent: 1, id, ack: true }                       요청을 받자마자
 *   응답 (studio -> 부모): { cbHwpAgent: 1, id, ok: true, result }                끝나면
 *                         { cbHwpAgent: 1, id, ok: false, error: { name, code, message, ... } }
 *
 * @rhwp/editor SDK 의 MessageChannel 과는 섞지 않는다. window 의 message 이벤트에서 cbHwpAgent 표시로만 구분한다.
 * 부모 출처는 frame-ancestors 와 같은 허용 목록으로 검사하고, 메서드는 hwpAgentMethods.js 목록만 받는다(guard 제외:
 * 함수를 넘겨야 해서 부모 쪽 client.js 가 직접 처리한다). 입출력은 글자, 숫자, 목록, 바이트 같은 단순한 값만 오간다.
 * 결과에 든 바이트(ArrayBuffer, Uint8Array 등)는 transferable 로 넘긴다.
 *
 * edit(label, fn) 은 함수를 보낼 수 없으므로 부모가 fn 을 기록한 계획 { steps: [{ method, args }], ret } 을 보낸다.
 * args/ret 안의 { $cbRef: k, path: [...] } 는 같은 묶음의 k 번째 단계 결과(의 path 속성)로 바꿔 넣는다.
 * 모든 단계는 hwpAgent.edit 안에서 한 트랜잭션(= undo 한 단계)으로 돈다.
 */
import { AGENT_METHODS } from './hwpAgentMethods.js'
import { HwpAgentError } from './hwpAgent.js'

/** frame-ancestors 와 같은 목록 (scripts/build.mjs 의 _headers) */
export const PARENT_ORIGINS = ['https://clipboardapp.org', 'https://www.clipboardapp.org', 'https://*.vercel.app', 'http://localhost:*', 'http://127.0.0.1:*']

/** 부모가 부를 수 있는 메서드 */
export const REMOTE_METHODS = AGENT_METHODS.filter((n) => n !== 'guard')

/** edit 묶음 안에서 쓸 수 있는 함수 (hwpAgent.edit 의 a 와 같은 이름) */
export const EDIT_STEP_METHODS = ['outline', 'find', 'getTable', 'listObjects',
  'replaceParagraph', 'insertParagraphAfter', 'deleteParagraphs', 'setParaShape', 'setCharShape', 'insertTable', 'deleteObject']

const bad = (code, message) => new HwpAgentError(code, message)

/** CSP 출처 식 (scheme://host[:port], host 앞 *. , port *) 하나와 맞는지 */
function matchOrigin(origin, pattern) {
  const m = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\*|\d+))?$/i.exec(pattern)
  if (!m) return false
  let u
  try { u = new URL(origin) } catch { return false }
  if (u.origin !== origin) return false // 경로·끝 / 가 붙은 값은 출처가 아니다
  const [, scheme, wild, host, port] = m
  if (u.protocol !== `${scheme}:`) return false
  if (wild) {
    if (!u.hostname.endsWith(`.${host}`)) return false
  } else if (u.hostname !== host) return false
  if (port === '*') return true
  return (u.port || '') === (port || '')
}

export function isAllowedParentOrigin(origin, patterns = PARENT_ORIGINS) {
  if (typeof origin !== 'string') return false
  return patterns.some((p) => matchOrigin(origin, p))
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isPlain = (v) => {
  if (!v || typeof v !== 'object') return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

/** args/ret 안의 { $cbRef, path } 를 앞 단계 결과로 바꾼다 */
export function resolveRefs(v, results) {
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, results))
  if (isPlain(v)) {
    if (own(v, '$cbRef')) {
      const k = v.$cbRef
      if (!Number.isInteger(k) || k < 0 || k >= results.length) throw bad('EDIT_REF', `edit: ${k} 번째 단계 결과가 아직 없습니다`)
      let cur = results[k]
      for (const key of Array.isArray(v.path) ? v.path : []) {
        if (cur === null || typeof cur !== 'object' || !own(cur, key)) throw bad('EDIT_REF', `edit: ${k} 번째 단계 결과에 ${String(key)} 가 없습니다`)
        cur = cur[key]
      }
      return cur
    }
    const out = {}
    for (const [key, x] of Object.entries(v)) out[key] = resolveRefs(x, results)
    return out
  }
  return v
}

/** 부모가 기록한 edit 계획을 hwpAgent.edit 에 넘길 동기 함수로 바꾼다 (검증은 문서를 건드리기 전에) */
export function planToFn(plan) {
  if (!isPlain(plan) || !Array.isArray(plan.steps)) throw bad('INVALID_ARG', 'edit: 계획 { steps: [{ method, args }] } 이 필요합니다')
  for (const s of plan.steps) {
    if (!isPlain(s) || !EDIT_STEP_METHODS.includes(s.method)) throw bad('INVALID_ARG', `edit: 묶음 안에서 쓸 수 없는 함수입니다: ${s && s.method}`)
    if (s.args !== undefined && !Array.isArray(s.args)) throw bad('INVALID_ARG', 'edit: args 는 목록이어야 합니다')
  }
  return (a) => {
    const results = []
    for (const s of plan.steps) results.push(a[s.method](...resolveRefs(s.args || [], results)))
    return resolveRefs(plan.ret, results)
  }
}

/** 오류를 단순한 값으로 (structured clone 가능한 것만) */
export function serializeError(e) {
  const out = { name: (e && e.name) || 'Error', message: String((e && e.message) || e) }
  if (e && e.code !== undefined) out.code = e.code
  if (e && typeof e === 'object') {
    for (const k of Object.keys(e)) {
      if (k === 'name' || k === 'message' || k === 'code' || k === 'cause' || k === 'stack') continue
      try { out[k] = JSON.parse(JSON.stringify(e[k])) } catch { /* 보낼 수 없는 값은 뺀다 */ }
    }
  }
  return out
}

/** 결과에 든 바이트 버퍼 (transferable) */
export function collectTransfer(v, out = new Set(), depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return [...out]
  if (v instanceof ArrayBuffer) out.add(v)
  else if (ArrayBuffer.isView(v)) { if (v.buffer instanceof ArrayBuffer) out.add(v.buffer) }
  else if (Array.isArray(v)) v.forEach((x) => collectTransfer(x, out, depth + 1))
  else if (isPlain(v)) Object.values(v).forEach((x) => collectTransfer(x, out, depth + 1))
  return [...out]
}

const isRequest = (d) => isPlain(d) && d.cbHwpAgent === 1 && typeof d.method === 'string' && !own(d, 'ok') && !own(d, 'ack') &&
  (typeof d.id === 'string' || typeof d.id === 'number')

/**
 * @param {{ win?: Window, agent: object, isAllowed?: (origin: string) => boolean }} o
 * @returns {() => void} 해제 함수
 */
export function installBridge({ win = globalThis.window, agent, isAllowed = isAllowedParentOrigin }) {
  const onMessage = async (ev) => {
    const d = ev.data
    if (!isRequest(d)) return
    if (!win.parent || win.parent === win || ev.source !== win.parent) return
    if (!isAllowed(ev.origin)) return
    const target = ev.source
    const origin = ev.origin
    const send = (msg, transfer = []) => {
      const m = { cbHwpAgent: 1, id: d.id, ...msg }
      try {
        target.postMessage(m, origin, transfer)
      } catch (e) {
        // 보낼 수 없는 결과: 오류로 바꿔 알린다
        try { target.postMessage({ cbHwpAgent: 1, id: d.id, ok: false, error: serializeError(bad('CLONE_FAILED', `결과를 보낼 수 없습니다: ${e && e.message}`)) }, origin) } catch { /* 부모가 없어짐 */ }
      }
    }
    send({ ack: true })
    try {
      if (!REMOTE_METHODS.includes(d.method)) throw bad('UNKNOWN_METHOD', `부를 수 없는 함수입니다: ${d.method}`)
      const args = Array.isArray(d.args) ? d.args : []
      let result
      if (d.method === 'edit') {
        const [label, plan, opts] = args
        result = await agent.edit(label, planToFn(plan), opts)
      } else {
        result = await agent[d.method](...args)
      }
      send({ ok: true, result: result === undefined ? null : result }, collectTransfer(result))
    } catch (e) {
      send({ ok: false, error: serializeError(e) })
    }
  }
  win.addEventListener('message', onMessage)
  return () => win.removeEventListener('message', onMessage)
}
