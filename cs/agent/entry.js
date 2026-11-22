/**
 * studio 페이지(index.html)에 함께 실리는 에이전트 진입점. iframe 으로 임베드됐을 때만 켠다.
 *  - createHwpAgent(() => window): 같은 출처라 facade·hwpctrl·대화상자 DOM 을 직접 쓴다
 *  - installBridge: 부모의 postMessage 요청을 받아 위 함수를 부른다
 *  - "문서 복구" 대화상자 감시를 켠다 (부팅 때 떠도 바로 "나중에")
 */
import { createHwpAgent } from './hwpAgent.js'
import { installBridge } from './bridge.js'

if (window.parent && window.parent !== window) {
  const agent = createHwpAgent(() => window)
  installBridge({ win: window, agent })
  const watch = () => { agent.dismissDialogs().catch(() => {}) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true })
  else watch()
}
