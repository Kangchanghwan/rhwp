import { describe, it, expect } from 'vitest';
import {
  enumerateTables, summarizeTables, readTableData, planSetCells, applyCellOps, verifyCellOps, findTable,
  planFillFields, verifyFills, validateSchema, NEW_TOOL_DEFS, validatePlanShape, findProducedByEarlierStep,
  buildHelp, HELP_MAX_CHARS, shortPurpose, argSignature,
} from './agent-tools-pure';
import type { TableWriter } from './agent-tools-pure';

/** 본문 문단 + 표(칸 목록)를 흉내 내는 가짜 문서. */
interface FakeCell { row: number; col: number; rowSpan?: number; colSpan?: number; paras: string[] }
interface FakeTable { rows: number; cols: number; cells: FakeCell[] }
function fakeDoc(paragraphs: Array<{ text: string; table?: FakeTable }>): TableWriter & { sections: typeof paragraphs } {
  const tableOf = (p: number, c: number) => {
    const t = paragraphs[p]?.table;
    if (!t || c !== 0) throw new Error('not a table');
    return t;
  };
  const cell = (p: number, c: number, i: number) => {
    const x = tableOf(p, c).cells[i];
    if (!x) throw new Error('cell out of range');
    return x;
  };
  return {
    sections: paragraphs,
    getSectionCount: () => 1,
    getParagraphCount: () => paragraphs.length,
    getParagraphLength: (_s, p) => paragraphs[p].text.length,
    getTextRange: (_s, p, o, n) => paragraphs[p].text.slice(o, o + n),
    getControlTextPositions: (_s, p) => JSON.stringify(paragraphs[p].table ? [0] : []),
    getTableDimensions: (_s, p, c) => { const t = tableOf(p, c); return JSON.stringify({ rowCount: t.rows, colCount: t.cols, cellCount: t.cells.length }); },
    getCellInfo: (_s, p, c, i) => { const x = cell(p, c, i); return JSON.stringify({ row: x.row, col: x.col, rowSpan: x.rowSpan ?? 1, colSpan: x.colSpan ?? 1 }); },
    getCellParagraphCount: (_s, p, c, i) => cell(p, c, i).paras.length,
    getCellParagraphLength: (_s, p, c, i, cp) => cell(p, c, i).paras[cp].length,
    getTextInCell: (_s, p, c, i, cp, o, n) => cell(p, c, i).paras[cp].slice(o, o + n),
    deleteTextInCell: (_s, p, c, i, cp, o, n) => { const x = cell(p, c, i); x.paras[cp] = x.paras[cp].slice(0, o) + x.paras[cp].slice(o + n); return '{"ok":true}'; },
    insertTextInCell: (_s, p, c, i, cp, o, t) => { const x = cell(p, c, i); x.paras[cp] = x.paras[cp].slice(0, o) + t + x.paras[cp].slice(o); return '{"ok":true}'; },
  };
}

function sample() {
  const grid: FakeTable = {
    rows: 3, cols: 3,
    cells: [
      { row: 0, col: 0, colSpan: 2, paras: ['제목'] }, { row: 0, col: 2, paras: [''] },
      { row: 1, col: 0, paras: ['A'] }, { row: 1, col: 1, paras: ['B'] }, { row: 1, col: 2, paras: ['C1', 'C2'] },
      { row: 2, col: 0, paras: ['D'] }, { row: 2, col: 1, paras: ['E'] }, { row: 2, col: 2, paras: ['F'] },
    ],
  };
  const simple: FakeTable = { rows: 2, cols: 2, cells: [
    { row: 0, col: 0, paras: ['x'] }, { row: 0, col: 1, paras: ['y'] }, { row: 1, col: 0, paras: ['z'] }, { row: 1, col: 1, paras: [''] },
  ] };
  return fakeDoc([{ text: '' }, { text: '신청 내역' }, { text: '', table: grid }, { text: '본문' }, { text: '', table: simple }]);
}

describe('표 열거·읽기', () => {
  it('문서 순서로 0부터 센다', () => {
    const d = sample();
    expect(enumerateTables(d).map((t) => [t.table, t.para])).toEqual([[0, 2], [1, 4]]);
    expect(findTable(d, 1)?.para).toBe(4);
    expect(findTable(d, 2)).toBeNull();
    expect(findTable(d, -1)).toBeNull();
  });
  it('요약: 병합·첫 칸·앞 글', () => {
    const s = summarizeTables(sample());
    expect(s[0]).toMatchObject({ table: 0, rows: 3, cols: 3, hasMerge: true, firstCellText: '제목', precedingText: '신청 내역' });
    expect(s[1]).toMatchObject({ table: 1, rows: 2, cols: 2, hasMerge: false, precedingText: '본문' });
  });
  it('read_table: 덮인 칸은 "", 병합 목록, 여러 문단은 줄바꿈', () => {
    const d = sample();
    const r = readTableData(d, findTable(d, 0)!);
    expect(r.cells).toEqual([['제목', '', ''], ['A', 'B', 'C1\nC2'], ['D', 'E', 'F']]);
    expect(r.merges).toEqual([{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }]);
    expect(readTableData(d, findTable(d, 0)!, undefined, 1)).toMatchObject({ rows: 3, truncated: true, shownRows: 1 });
  });
});

describe('set_cells 계획', () => {
  const ref = (d: ReturnType<typeof sample>, n = 0) => findTable(d, n)!;
  it('병합에 덮인 칸은 COVERED_BY_MERGE + anchor 좌표, 아무것도 쓰지 않는다', () => {
    const d = sample();
    const p = planSetCells(d, ref(d), [{ row: 1, col: 0, text: 'ok' }, { row: 0, col: 1, text: 'no' }]);
    expect(p.ops).toEqual([]);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]).toMatchObject({ index: 1, code: 'COVERED_BY_MERGE' });
    expect(p.issues[0].message).toContain('anchor row 0, col 0');
  });
  it('범위·중복·여러 문단·제어 문자를 모두 보고한다', () => {
    const d = sample();
    const p = planSetCells(d, ref(d), [
      { row: 3, col: 0, text: 'a' }, { row: 1, col: 0, text: 'a' }, { row: 1, col: 0, text: 'b' },
      { row: 1, col: 2, text: 'c' }, { row: 2, col: 0, text: 'x\ny' },
    ]);
    expect(p.issues.map((i) => i.code)).toEqual(['OUT_OF_RANGE', 'DUPLICATE_CELL', 'MULTI_PARAGRAPH_CELL', 'INVALID_INPUT']);
    expect(p.ops).toEqual([]);
  });
  it('적용 → 재읽기, 같은 글은 unchanged, 빈 글은 지운다', () => {
    const d = sample();
    const r = ref(d, 1);
    const p = planSetCells(d, r, [{ row: 0, col: 0, text: 'x' }, { row: 0, col: 1, text: 'Y2' }, { row: 1, col: 0, text: '' }]);
    expect(p.issues).toEqual([]);
    expect(p.unchanged).toBe(1);
    expect(p.ops.map((o) => [o.row, o.col, o.oldText, o.newText])).toEqual([[0, 1, 'y', 'Y2'], [1, 0, 'z', '']]);
    applyCellOps(d, r, p.ops);
    expect(readTableData(d, r).cells).toEqual([['x', 'Y2'], ['', '']]);
    expect(verifyCellOps(d, r, p.ops)).toBe(true);
    // 되돌려 쓰지 않았다면 verified 는 false
    d.sections[4].table!.cells[1].paras[0] = 'tampered';
    expect(verifyCellOps(d, r, p.ops)).toBe(false);
  });
});

describe('fill_fields 계획', () => {
  const fields = [
    { fieldId: 1, name: '성명', value: '' }, { fieldId: 2, name: '주소', value: '서울' },
    { fieldId: 3, name: '자녀', value: '' }, { fieldId: 4, name: '자녀', value: '' },
  ];
  it('있음·없음·중복·순번·같은 값을 구분한다', () => {
    const p = planFillFields(fields, { 성명: '홍길동', 없는이름: 'x', 자녀: 'a', '자녀[2]': 'b', 주소: '서울', '자녀[3]': 'c' });
    expect(p.fills.map((f) => [f.name, f.fieldId, f.value])).toEqual([['성명', 1, '홍길동'], ['자녀[2]', 4, 'b']]);
    expect(p.unchanged).toEqual([{ name: '주소', occurrence: 1, value: '서울' }]);
    expect(p.notFound).toEqual(['없는이름', '자녀[3]']);
    expect(p.ambiguous).toEqual([{ name: '자녀', matched: 2, total: 2 }]);
  });
  it('값이 문자열이 아니거나 줄바꿈이면 invalid', () => {
    const p = planFillFields(fields, { 성명: 'a\nb', 주소: 3 as unknown as string, '자녀[1]': 'p', '자녀[1] ': 'q' });
    expect(p.invalid.map((i) => i.name)).toEqual(['성명', '주소']);
    expect(p.fills).toHaveLength(1);
  });
  it('verifyFills 는 다시 읽은 값으로 판정', () => {
    const p = planFillFields(fields, { 성명: '홍' });
    expect(verifyFills([{ fieldId: 1, name: '성명', value: '홍' }], p.fills)).toBe(true);
    expect(verifyFills([{ fieldId: 1, name: '성명', value: '' }], p.fills)).toBe(false);
    expect(verifyFills([], p.fills)).toBe(false);
  });
});

describe('입력 검증기', () => {
  const setCells = NEW_TOOL_DEFS.find((d) => d.name === 'set_cells')!.inputSchema;
  it('정상·오류를 가린다', () => {
    expect(validateSchema(setCells, { table: 0, cells: [{ row: 0, col: 1, text: 'a' }] })).toBeNull();
    expect(validateSchema(setCells, { table: 0 })).toMatch(/cells is required/);
    expect(validateSchema(setCells, { table: -1, cells: [{ row: 0, col: 0, text: '' }] })).toMatch(/table must be >= 0/);
    expect(validateSchema(setCells, { table: 0, cells: [{ row: 0.5, col: 0, text: '' }] })).toMatch(/integer/);
    expect(validateSchema(setCells, { table: 0, cells: [{ row: 0, col: 0, text: 3 }] })).toMatch(/string/);
    expect(validateSchema(setCells, { table: 0, cells: [{ row: 0, col: 0, text: '', extra: 1 }] })).toMatch(/not allowed/);
    expect(validateSchema(setCells, { table: 0, cells: [] })).toMatch(/at least 1/);
    expect(validateSchema(setCells, { table: 0, cells: [{ row: 0, col: 0, text: '' }], x: 1 })).toMatch(/not allowed/);
  });
  it('fill_fields 의 values 는 문자열 맵', () => {
    const s = NEW_TOOL_DEFS.find((d) => d.name === 'fill_fields')!.inputSchema;
    expect(validateSchema(s, { values: { a: 'b' } })).toBeNull();
    expect(validateSchema(s, { values: { a: 1 } })).toMatch(/string/);
    expect(validateSchema(s, { values: [] })).toMatch(/object/);
  });
  it('모든 새 도구는 object schema 와 설명을 가진다', () => {
    for (const d of NEW_TOOL_DEFS) {
      expect(d.inputSchema.type).toBe('object');
      expect(d.description.length).toBeGreaterThan(40);
      expect(['read', 'write']).toContain(d.group);
    }
    expect(NEW_TOOL_DEFS.map((d) => d.name)).toEqual(['list_tables', 'read_table', 'set_cells', 'fill_fields', 'run_plan']);
  });
});

describe('run_plan 보조', () => {
  it('모양 검증', () => {
    expect(validatePlanShape([{ tool: 'a' }])).toEqual({ ok: true, steps: [{ tool: 'a', args: {} }] });
    expect(validatePlanShape([])).toMatchObject({ ok: false });
    expect(validatePlanShape([{ args: {} }])).toMatchObject({ ok: false });
    expect(validatePlanShape('x')).toMatchObject({ ok: false });
  });
  it('앞 단계가 만든 글을 찾는 연쇄만 늦은 검증으로 넘긴다', () => {
    const earlier = [{ find: 'A', replace: '새로운 문장 XYZ' }];
    expect(findProducedByEarlierStep('XYZ', earlier)).toBe(true);
    expect(findProducedByEarlierStep('없는글', earlier)).toBe(false);
    expect(findProducedByEarlierStep('', earlier)).toBe(false);
    expect(findProducedByEarlierStep(undefined, earlier)).toBe(false);
    expect(findProducedByEarlierStep('x', [])).toBe(false);
  });
});

describe('help', () => {
  const tools = Array.from({ length: 45 }, (_, i) => ({
    name: `tool_${i}`, group: i < 10 ? 'read' : i < 42 ? 'write' : 'command',
    description: `Do something number ${i} with the document and a very long explanation that goes on and on. Second sentence.`,
    inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] },
  }));
  it('짧고, 시작법·규칙·오류 코드·모든 도구를 담는다', () => {
    const h = buildHelp(tools);
    expect(h.length).toBeLessThanOrEqual(HELP_MAX_CHARS);
    expect(h.length).toBeLessThan(6000);
    expect(h).toContain('get_document_info');
    expect(h).toContain('run_plan');
    expect(h).toContain('COVERED_BY_MERGE');
    expect(h).toContain('글자 그대로');
    for (const t of tools) expect(h).toContain(t.name);
  });
  it('보조 함수', () => {
    expect(shortPurpose('Read things. More.')).toBe('Read things');
    expect(shortPurpose('x'.repeat(100), 10)).toHaveLength(10);
    expect(argSignature({ properties: { a: {}, b: {} }, required: ['a'] })).toBe('a, b?');
  });
});
