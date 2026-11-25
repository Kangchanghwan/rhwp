import { describe, it, expect } from 'vitest'
import { shouldShowNotice, NOTICE_KEY } from './directNotice.js'

const mk = (search, { top = true } = {}) => { const w = { location: { search } }; w.top = top ? w : {}; return w }
const store = (v) => ({ getItem: () => v })

describe('직접 접속 안내', () => {
  it('최상위 창이면 보인다', () => expect(shouldShowNotice({ win: mk(''), storage: store(null) })).toBe(true))
  it('iframe 안에서는 안 보인다', () => expect(shouldShowNotice({ win: mk('', { top: false }), storage: store(null) })).toBe(false))
  it('embed=cs 이면 안 보인다', () => expect(shouldShowNotice({ win: mk('?embed=cs'), storage: store(null) })).toBe(false))
  it('닫은 기록이 있으면 안 보인다', () => expect(shouldShowNotice({ win: mk(''), storage: store('1') })).toBe(false))
  it('저장소가 막혀도 보인다', () => expect(shouldShowNotice({ win: mk(''), storage: { getItem: () => { throw new Error('x') } } })).toBe(true))
  it('키 이름', () => expect(NOTICE_KEY).toBe('cs-direct-notice-dismissed'))
})
