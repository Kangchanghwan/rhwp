/**
 * 주소창으로 직접 들어온 사람에게 www 도구 페이지 링크를 보여 주는 얇은 한 줄(높이 28px).
 * 최상위 창이고 embed=cs 가 아닐 때만 뜬다. 닫으면 localStorage 에 기억한다. 외부 리소스·리다이렉트 없음.
 */
export const NOTICE_HEIGHT = 28
export const NOTICE_KEY = 'cs-direct-notice-dismissed'
export const NOTICE_TEXT = '설명과 사용법은 www.clipboardapp.org/tools/hwp/ 에서 볼 수 있어요'
export const NOTICE_HREF = 'https://www.clipboardapp.org/tools/hwp/'

export function shouldShowNotice({ win, storage }) {
  let top = false
  try { top = win.top === win } catch { top = false }
  if (!top) return false
  if (new URLSearchParams(win.location.search).get('embed') === 'cs') return false
  try { if (storage && storage.getItem(NOTICE_KEY) === '1') return false } catch { /* 저장소 막힘: 그냥 보여 줌 */ }
  return true
}

export function installDirectNotice({ win = window, doc = document, storage } = {}) {
  if (storage === undefined) { try { storage = win.localStorage } catch { storage = null } }
  if (!shouldShowNotice({ win, storage })) return null
  const style = doc.createElement('style')
  style.textContent = `#studio-root{height:calc(100vh - ${NOTICE_HEIGHT}px)!important}
#cs-direct-notice{position:fixed;left:0;right:0;bottom:0;height:${NOTICE_HEIGHT}px;z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:10px;box-sizing:border-box;padding:0 12px;font:12px/1 system-ui,-apple-system,sans-serif;background:#eef2f7;color:#334;border-top:1px solid #d5dbe3;white-space:nowrap;overflow:hidden}
#cs-direct-notice a{color:#2b6cb0;text-decoration:underline}
#cs-direct-notice button{border:0;background:transparent;color:#667;font-size:16px;line-height:1;cursor:pointer;padding:0 4px}`
  const bar = doc.createElement('div')
  bar.id = 'cs-direct-notice'
  bar.setAttribute('role', 'note')
  const a = doc.createElement('a')
  a.href = NOTICE_HREF; a.target = '_blank'; a.rel = 'noopener'; a.textContent = NOTICE_TEXT
  const x = doc.createElement('button')
  x.type = 'button'; x.setAttribute('aria-label', '닫기'); x.textContent = '×'
  const close = () => {
    try { storage && storage.setItem(NOTICE_KEY, '1') } catch { /* 무시 */ }
    bar.remove(); style.remove()
  }
  x.addEventListener('click', close)
  bar.append(a, x)
  const mount = () => { (doc.head || doc.documentElement).append(style); (doc.body || doc.documentElement).append(bar) }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
  return { bar, style, close }
}
