import { describe, it, expect } from 'vitest';
import { normalizedMatchesIn, buildWhitespacePattern, longestToken, resolveLocator, findNormalized } from './agent-tools-pure';
import type { SearchDoc } from './agent-tools-pure';

const texts = (t: string, q: string) => normalizedMatchesIn(t, q).map((m) => m.text);

describe('공백 관용 일치(문단 안)', () => {
  it('U+2007(숫자 공백), U+00A0, U+3000, 탭, 이중 공백을 한 공백으로 본다', () => {
    expect(texts('(단위\u2007: 백만 달러, %)', '(단위 : 백만 달러, %)')).toEqual(['(단위\u2007: 백만 달러, %)']);
    expect(texts('가\u00A0나', '가 나')).toEqual(['가\u00A0나']);
    expect(texts('가\u3000나', '가 나')).toEqual(['가\u3000나']);
    expect(texts('가\t나', '가 나')).toEqual(['가\t나']);
    expect(texts('가   나', '가 나')).toEqual(['가   나']);
    expect(texts('가 나', '가    나')).toEqual(['가 나']);
    expect(texts('가\u2003\u2009나', '가 나')).toEqual(['가\u2003\u2009나']);
  });
  it('앞뒤 공백도 공백 덩어리다(문서에 공백이 있어야 맞는다)', () => {
    expect(texts('x 가 y', ' 가 ')).toEqual([' 가 ']);
    expect(texts('x가y', ' 가 ')).toEqual([]);
    expect(texts('x 가y', '가 ')).toEqual([]);
  });
  it('공백이 없는 질의는 다른 낱말 사이를 건너 맞추지 않는다', () => {
    expect(texts('가 나', '가나')).toEqual([]);
    expect(texts('가\u2007나', '가나')).toEqual([]);
    expect(texts('가나', '가나')).toEqual(['가나']);
  });
  it('공백 있는 질의는 공백 없는 문서에 맞지 않는다(1개 이상 필요)', () => {
    expect(texts('가나', '가 나')).toEqual([]);
  });
  it('폭 없는 공백(U+200B, U+FEFF)은 공백 구실을 하고, 질의 속 폭 없는 글자만 있으면 있어도 없어도 된다', () => {
    expect(texts('가\u200B나', '가 나')).toEqual(['가\u200B나']);
    expect(texts('가\uFEFF나', '가\u200B나')).toEqual(['가나'.replace('나', '\uFEFF나')]);
    expect(texts('가나', '가\u200B나')).toEqual(['가나']);
  });
  it('대소문자·문장부호·정규식 특수문자는 그대로 비교한다', () => {
    expect(texts('Abc, d', 'abc, d')).toEqual([]);
    expect(texts('a.b (c)', 'a.b (c)')).toEqual(['a.b (c)']);
    expect(texts('axb', 'a.b')).toEqual([]);
    expect(texts('a、b', 'a, b')).toEqual([]);
  });
  it('겹치지 않게 앞에서부터 여러 번 맞는다', () => {
    expect(texts('가 나, 가\u2007나', '가 나')).toEqual(['가 나', '가\u2007나']);
  });
  it('보조 함수', () => {
    expect(longestToken('가 나다라 마')).toBe('나다라');
    expect(longestToken('  \u2007 ')).toBe('');
    expect(normalizedMatchesIn('abc', ' ')).toEqual([]);
    expect(buildWhitespacePattern('a b').source).toContain('+');
  });
});

/** 본문 문단만 있는 가짜 검색 문서(정확 일치 검색, 읽는 순서). */
function searchDoc(paras: string[]): SearchDoc {
  return {
    searchAllText: (q) => {
      const hits: unknown[] = [];
      paras.forEach((t, para) => { for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) hits.push({ sec: 0, para, charOffset: i, length: q.length }); });
      return JSON.stringify(hits);
    },
    getParagraphLength: (_s, p) => paras[p].length,
    getTextRange: (_s, p, o, n) => paras[p].slice(o, o + n),
    getCellParagraphLength: () => 0,
    getTextInCell: () => '',
  };
}

describe('resolveLocator', () => {
  it('정확히 있으면 손대지 않는다(정규화 안 함)', () => {
    expect(resolveLocator(searchDoc(['(단위 : 백만 달러)', '(단위\u2007: 백만 달러)']), '(단위 : 백만 달러)', undefined, true)).toEqual({ kind: 'exact' });
  });
  it('없으면 문서의 정확한 글로 바꾼다', () => {
    const r = resolveLocator(searchDoc(['머리', '(단위\u2007: 백만 달러, %)']), '(단위 : 백만 달러, %)', undefined, true);
    expect(r).toEqual({ kind: 'normalized', find: '(단위\u2007: 백만 달러, %)', matchedText: '(단위\u2007: 백만 달러, %)' });
  });
  it('어디에도 없으면 none', () => {
    expect(resolveLocator(searchDoc(['가나다']), '라 마', undefined, true)).toEqual({ kind: 'none' });
    expect(resolveLocator(searchDoc(['가나다']), '   ', undefined, true)).toEqual({ kind: 'none' });
  });
  it('정규화 일치가 여럿이고 occurrence 가 없으면 AMBIGUOUS_TARGET', () => {
    const r = resolveLocator(searchDoc(['가\u2007나', '가\u00A0나', '가\t나']), '가 나', undefined, true);
    expect(r).toMatchObject({ kind: 'error', code: 'AMBIGUOUS_TARGET' });
    expect((r as { message: string }).message).toContain('3 places');
  });
  it('occurrence 는 정규화 일치의 순번이고, 정확한 글 안의 순번으로 바꿔 넘긴다', () => {
    const doc = searchDoc(['가\u2007나', '가\u00A0나', '가\u2007나']);
    expect(resolveLocator(doc, '가 나', 1, true)).toMatchObject({ kind: 'normalized', find: '가\u2007나', occurrence: 1 });
    expect(resolveLocator(doc, '가 나', 2, true)).toMatchObject({ kind: 'normalized', find: '가\u00A0나', occurrence: 1 });
    expect(resolveLocator(doc, '가 나', 3, true)).toMatchObject({ kind: 'normalized', find: '가\u2007나', occurrence: 2 });
    expect(resolveLocator(doc, '가 나', 4, true)).toMatchObject({ kind: 'error', code: 'REFUSED' });
  });
  it('한 문단에 같은 글이 두 번이면 문단 안 순번까지 센다', () => {
    const doc = searchDoc(['가\u2007나 그리고 가\u2007나']);
    expect(findNormalized(doc, '가 나')).toHaveLength(2);
    expect(resolveLocator(doc, '가 나', 2, true)).toMatchObject({ find: '가\u2007나', occurrence: 2 });
  });
  it('occurrence 인자가 없는 도구에서 정확한 글이 여러 곳이면 모호하다', () => {
    const doc = searchDoc(['가\u2007나', '가\u2007나 또']);
    // 정규화 일치 2개 → occurrence 를 줄 수 없으니 모호
    expect(resolveLocator(doc, '가 나', undefined, false)).toMatchObject({ kind: 'error', code: 'AMBIGUOUS_TARGET' });
    expect(resolveLocator(searchDoc(['x 가\u2007나']), '가 나', undefined, false)).toMatchObject({ kind: 'normalized', find: '가\u2007나' });
  });
});
