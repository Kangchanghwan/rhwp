/* 시험용 가짜 HwpDocument 와 studio 창 (hwpAgent.test.js, bridge.test.js 가 함께 쓴다) */

/**
 * 메모리 안의 가짜 HwpDocument. 실제 엔진에서 실측한 동작만 흉내 낸다.
 *  - 읽기: 여백·들여쓰기·문단 간격은 px (= 쓰기 값 / 150, 간격은 / 75), 소수 한 자리
 *  - 쓰기: 여백·들여쓰기는 pt×200, 간격·글자 크기는 pt×100
 *  - splitParagraph 는 문단 모양을 잇고, createTable 의 칸 문단은 표를 만든 문단의 모양을 물려받는다 (실측 결함)
 */
export function makeDoc(paras) {
  const state = {
    paras: paras.map((p) => ({ text: p.text, ps: { align: 'justify', ml: 0, mr: 0, indent: 0, sb: 0, sa: 0, ls: 160, lsType: 'Percent', ...(p.ps || {}) }, cs: { size: 1000, bold: false, font: '함초롬바탕', ...(p.cs || {}) }, ctrls: p.ctrls || [] })),
    calls: [],
    mutations: 0,
  }
  const px = (raw, k) => Math.round((raw / k) * 10) / 10
  const need = (i) => { if (!state.paras[i]) throw new Error('문단 인덱스 범위 초과 ' + i); return state.paras[i] }
  const mut = (name, fn) => (...args) => { state.mutations++; state.calls.push(name); return fn(...args) }
  const OK = JSON.stringify({ ok: true })
  const d = {
    getSectionCount: () => 1,
    getParagraphCount: () => state.paras.length,
    getParagraphLength: (s, i) => need(i).text.length,
    getLogicalLength: (s, i) => need(i).text.length + need(i).ctrls.length * 8,
    getTextRange: (s, i, off, n) => need(i).text.slice(off, off + n),
    getControlTextPositions: (s, i) => JSON.stringify(need(i).ctrls.map(() => 0)),
    getParaPropertiesAt: (s, i) => {
      const p = need(i).ps
      return JSON.stringify({ alignment: p.align, lineSpacing: p.ls, lineSpacingType: p.lsType, marginLeft: px(p.ml, 150), marginRight: px(p.mr, 150), indent: px(p.indent, 150), spacingBefore: px(p.sb, 75), spacingAfter: px(p.sa, 75), paraShapeId: 1, headType: p.head || 'None' })
    },
    getCharPropertiesAt: (s, i) => {
      const c = need(i).cs
      return JSON.stringify({ fontFamily: c.font, fontSize: c.size, bold: c.bold, charShapeId: 3 })
    },
    getStyleAt: () => JSON.stringify({ id: 0, name: '바탕글' }),
    getControls: () => {
      const out = []
      state.paras.forEach((p, i) => p.ctrls.forEach((c, k) => out.push({ ctrlId: c.id, userDesc: c.desc || '', list: 0, para: i, controlIndex: k, props: { Width: 28346, Height: 14173 } })))
      return JSON.stringify(out)
    },
    getPictureProperties: (s, i, k) => { if (need(i).ctrls[k].pic) return '{}'; throw new Error('그림이 아닙니다') },
    getTextBoxControlIndex: (s, i) => need(i).ctrls.findIndex((c) => c.textbox),
    searchAllText: (q) => JSON.stringify(state.paras.flatMap((p, i) => (p.text.includes(q) ? [{ sec: 0, para: i, charOffset: p.text.indexOf(q), length: q.length }] : []))),
    getPageDef: () => JSON.stringify({ width: 59528, marginLeft: 5102, marginRight: 5102, marginGutter: 0 }),
    getTextFileUnicode: () => JSON.stringify(state.paras.map((p) => p.text).join('\r\n')),
    pageCount: () => 1,
    // 표
    getTableDimensions: (s, i, k) => { const t = need(i).ctrls[k]; return JSON.stringify({ rowCount: t.rows, colCount: t.cols, cellCount: t.rows * t.cols }) },
    getCellInfo: (s, i, k, c) => { const t = need(i).ctrls[k]; return JSON.stringify({ row: Math.floor(c / t.cols), col: c % t.cols, rowSpan: 1, colSpan: 1 }) },
    getCellParagraphCount: () => 1,
    getCellParagraphLength: (s, i, k, c) => need(i).ctrls[k].cells[c].text.length,
    getTextInCell: (s, i, k, c) => need(i).ctrls[k].cells[c].text,
    getTableProperties: (s, i, k) => JSON.stringify({ tableWidth: need(i).ctrls[k].width || 0 }),
    // 쓰기
    insertText: mut('insertText', (s, i, off, t) => { const p = need(i); p.text = p.text.slice(0, off) + t + p.text.slice(off); return OK }),
    deleteText: mut('deleteText', (s, i, off, n) => { const p = need(i); p.text = p.text.slice(0, off) + p.text.slice(off + n); return OK }),
    deleteParagraph: mut('deleteParagraph', (s, i) => { need(i); state.paras.splice(i, 1); return OK }),
    splitParagraph: mut('splitParagraph', (s, i) => { const p = need(i); state.paras.splice(i + 1, 0, { text: '', ps: { ...p.ps }, cs: { ...p.cs }, ctrls: [] }); return JSON.stringify({ ok: true, paraIdx: i + 1 }) }),
    setParaShapeId: mut('setParaShapeId', (s, i) => { need(i); return OK }),
    setCharShapeId: mut('setCharShapeId', (s, i) => { need(i); return OK }),
    applyParaFormat: mut('applyParaFormat', (s, i, json) => {
      const p = need(i).ps; const v = JSON.parse(json)
      if (v.alignment !== undefined) p.align = v.alignment
      if (v.marginLeft !== undefined) p.ml = v.marginLeft
      if (v.marginRight !== undefined) p.mr = v.marginRight
      if (v.indent !== undefined) p.indent = v.indent
      if (v.spacingBefore !== undefined) p.sb = v.spacingBefore
      if (v.spacingAfter !== undefined) p.sa = v.spacingAfter
      if (v.lineSpacing !== undefined) p.ls = v.lineSpacing
      return OK
    }),
    applyCharFormat: mut('applyCharFormat', (s, i, a, b, json) => { const c = need(i).cs; const v = JSON.parse(json); if (v.fontSize !== undefined) c.size = v.fontSize; if (v.bold !== undefined) c.bold = v.bold; return OK }),
    findOrCreateFontId: mut('findOrCreateFontId', () => 7),
    applyStyle: mut('applyStyle', () => OK),
    createTable: mut('createTable', (s, i, off, rows, cols) => {
      const p = need(i)
      const cells = Array.from({ length: rows * cols }, () => ({ text: '', ps: { ...p.ps } })) // 칸 문단이 본문 문단 모양을 물려받는다
      p.ctrls.push({ id: 'tbl', rows, cols, cells, width: 41952 })
      state.paras.splice(i + 1, 0, { text: '', ps: { ...p.ps }, cs: { ...p.cs }, ctrls: [] })
      return JSON.stringify({ ok: true, paraIdx: i, controlIdx: p.ctrls.length - 1 })
    }),
    setCellProperties: mut('setCellProperties', (s, i, k, c, json) => { const v = JSON.parse(json); if (v.width) need(i).ctrls[k].cells[c].width = v.width; if (v.fillColor) need(i).ctrls[k].cells[c].fill = v.fillColor; return OK }),
    setTableProperties: mut('setTableProperties', () => OK),
    applyParaFormatInCell: mut('applyParaFormatInCell', (s, i, k, c, cp, json) => {
      const cell = need(i).ctrls[k].cells[c]; const v = JSON.parse(json)
      if (v.marginLeft !== undefined) cell.ps.ml = v.marginLeft
      if (v.indent !== undefined) cell.ps.indent = v.indent
      if (v.alignment !== undefined) cell.ps.align = v.alignment
      return OK
    }),
    insertTextInCell: mut('insertTextInCell', (s, i, k, c, cp, off, t) => { need(i).ctrls[k].cells[c].text += t; return OK }),
    applyCharFormatInCell: mut('applyCharFormatInCell', (s, i, k, c, cp, a, b, json) => { const v = JSON.parse(json); const cell = need(i).ctrls[k].cells[c]; if (v.bold) cell.bold = true; if (v.fontSize) cell.size = v.fontSize; return OK }),
    deleteTableControl: mut('deleteTableControl', (s, i, k) => { need(i).ctrls.splice(k, 1); return OK }),
    deleteShapeControl: mut('deleteShapeControl', (s, i, k) => { need(i).ctrls.splice(k, 1); return OK }),
    deletePictureControl: mut('deletePictureControl', (s, i, k) => { need(i).ctrls.splice(k, 1); return OK }),
  }
  return { d, state }
}

/** studio 의 transaction / 명령 오류 경계를 흉내 낸다 (스냅샷 롤백, 트랩이면 잠금). */
export function makeWindow(doc) {
  const { d, state } = doc
  const env = { txCount: 0, status: 'ready', undone: 0, redone: 0 }
  const snapshot = () => structuredClone(state.paras)
  const facade = {
    read: (fn) => fn(d),
    transaction(label, fn) {
      env.txCount++
      const before = snapshot()
      try {
        fn({ doc: () => d, deferPagination() {} })
      } catch (e) {
        state.paras = before // 스냅샷 롤백
        env.status = e && e.trap ? 'blocked' : 'ready'
        const err = new Error('Studio 편집 명령을 완료하지 못했습니다.')
        err.name = 'StudioCommandError'
        err.cause = e
        err.report = Promise.resolve({ recovery: e && e.trap ? 'unknown' : 'succeeded' })
        throw err
      }
    },
  }
  const win = {
    rhwpStudio: { plugins: { loaded: new Map([['hwpctrl', { facade, surface: { undo: () => { env.undone++ }, redo: () => { env.redone++ } } }]]) } },
    rhwpCommandErrors: { getState: () => ({ status: env.status }) },
  }
  return { win, env }
}

export const sample = () => makeDoc([
  { text: '', ctrls: [{ id: 'secd' }, { id: 'cold' }] },
  { text: '제목입니다', ps: { align: 'center', ml: 4000, indent: -2000, sb: 700 }, cs: { size: 1600, bold: true } },
  { text: '본문 첫 줄' },
  { text: '', ctrls: [{ id: 'tbl', rows: 1, cols: 2, cells: [{ text: '작성방법' }, { text: '내용' }] }] },
  { text: '', ctrls: [{ id: 'gso', textbox: true, desc: '글상자' }] },
  { text: '끝' },
])

