#!/usr/bin/env node
/**
 * cs-agent-tools 로컬 헤드리스 e2e.
 *   node cs/gate/agent-tools.e2e.mjs [--dist <dir>] [--samples <dir>] [--sample a.hwpx --sample b.hwp]
 * - dist 가 없으면 RHWP_WITHOUT_AI=1 로 rhwp-studio 를 빌드한다(pkg/ 필요: cs/README.md 참고).
 * - 샘플은 --samples 폴더 또는 git(HEAD:samples/…) 에서 읽는다.
 * - playwright 는 import 되거나 PLAYWRIGHT_DIR(node_modules 가 있는 폴더) 에서 찾는다.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const optAll = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));

console.log('[e2e] start');
let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  const base = process.env.PLAYWRIGHT_DIR || '/tmp/s3';
  ({ chromium } = createRequire(join(base, 'noop.js'))('playwright'));
}

let dist = opt('--dist') ? resolve(opt('--dist')) : undefined;
if (!dist) {
  dist = join(repo, 'rhwp-studio', 'dist-e2e');
  console.log('[e2e] building (RHWP_WITHOUT_AI=1)…');
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: join(repo, 'rhwp-studio'), stdio: 'inherit', env: { ...process.env, RHWP_WITHOUT_AI: '1' },
  });
}
const samples = optAll('--sample').length ? optAll('--sample')
  : ['samples/3-09월_교육_통합_2022.hwpx', 'samples/3-09월_교육_통합_2022.hwp'];
const samplesDir = opt('--samples');
const loadSample = (rel) => {
  if (samplesDir && existsSync(join(samplesDir, rel.replace(/^samples\//, '')))) return readFileSync(join(samplesDir, rel.replace(/^samples\//, '')));
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: repo, maxBuffer: 1 << 28 });
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = join(dist, p);
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', MIME[extname(f)] ?? 'application/octet-stream');
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const within = (promise, ms, what) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms))]);
const report = { url, startedAt: new Date().toISOString(), samples: {}, passed: 0, failed: 0 };
console.log('[e2e] serving', url, dist);
const browser = await chromium.launch({ headless: true });

async function runSample(rel) {
  const steps = {};
  const rec = (name, pass, detail) => { steps[name] = { pass: !!pass, ...detail }; report[pass ? 'passed' : 'failed']++; console.log(`${pass ? 'PASS' : 'FAIL'} [${rel}] ${name}`, JSON.stringify(detail ?? {}).slice(0, 300)); };
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('[e2e] page opened', rel);
  await page.waitForFunction(() => window.rhwpStudio?.csAgentTools, null, { timeout: 30000 });
  const b64 = loadSample(rel).toString('base64');
  const name = rel.split('/').pop();

  const load = (b, n) => within(page.evaluate(async ({ b, n }) => {
    const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return await window.rhwpStudio.csAgentTools.loadDocument(u, n);
  }, { b, n }), 90000, 'loadDocument');
  const call = (tool, a, o) => within(page.evaluate(({ tool, a, o }) => window.rhwpStudio.csAgentTools.callTool(tool, a, o), { tool, a, o }), 120000, `callTool ${tool}`);
  const state = async () => {
    const info = (await call('get_document_info', {})).result;
    // 글자 수는 문서 모델의 문단 텍스트(본문+표 칸 제외 아님: read_paragraphs 기준)로 센다.
    // 쪽 배치 텍스트(read_page_text)는 옛한글 조합 때문에 편집 직후 글자 수가 달라질 수 있어 쓰지 않는다.
    let len = 0;
    for (let sec = 0; sec < info.sectionCount; sec++) {
      let from = 0;
      for (;;) {
        const r = (await call('read_paragraphs', { section: sec, from, count: 50 })).result;
        for (const p of r.paragraphs) len += (p.text ?? '').length;
        if (!r.truncated || r.nextFrom === undefined) break;
        from = r.nextFrom;
      }
    }
    // 표 칸까지 포함한 쪽 배치 글자 수(참고용 + hwpx 왕복 판정에 사용)
    let layoutLen = 0;
    for (let pg = 1; pg <= info.pageCount; pg++) {
      let off = 0;
      for (;;) {
        const r = (await call('read_page_text', { page: pg, offset: off })).result;
        layoutLen += r.text.length;
        if (!r.truncated) break; off = r.nextOffset;
      }
    }
    return { pageCount: info.pageCount, paragraphCounts: info.paragraphCounts, textLen: len, layoutLen };
  };

  let r = null;
  for (let i = 0; i < 20; i++) { r = await load(b64, name); if (r.ok) break; await page.waitForTimeout(500); }
  rec('0_load', r?.ok, { r });
  await page.waitForTimeout(500);

  // 1) listTools
  const tools = await page.evaluate(() => window.rhwpStudio.csAgentTools.listTools());
  const byGroup = {};
  for (const t of tools) (byGroup[t.group] ??= []).push(t.name);
  const counts = Object.fromEntries(Object.entries(byGroup).map(([g, n]) => [g, n.length]));
  const shapeOk = tools.every((t) => t.name && t.group && typeof t.description === 'string' && t.inputSchema?.type === 'object' && typeof t.headless === 'boolean');
  const NEW = ['list_tables', 'read_table', 'set_cells', 'fill_fields', 'run_plan'];
  const baseTools = tools.filter((t) => !NEW.includes(t.name));
  const baseCounts = {}; for (const t of baseTools) baseCounts[t.group] = (baseCounts[t.group] ?? 0) + 1;
  rec('1_listTools', baseCounts.read === 8 && baseCounts.write === 29 && baseCounts.command === 3 && shapeOk && !tools.some((t) => t.name === 'create_document')
    && NEW.every((n) => tools.some((t) => t.name === n && t.headless === true)) && tools.length === 45,
    { counts, baseCounts, total: tools.length, names: byGroup, nonHeadless: tools.filter((t) => !t.headless).map((t) => t.name) });

  // 2) read paragraphs / outline
  const before = await state();
  const outline = await call('get_outline', {});
  const paras = await call('read_paragraphs', { section: 0, from: 0, count: 50 });
  const plist = paras.result?.paragraphs ?? paras.result?.items ?? [];
  const texts = plist.map((p) => p.text).filter((t) => typeof t === 'string');
  const cand = texts.find((t) => t.trim().length >= 8 && !/\s{2,}/.test(t.trim().slice(0, 8)));
  const find = cand ? [...cand.trim()].slice(0, 6).join('') : null;
  rec('2_read', outline.ok && paras.ok && !!find, { before, outlineItems: outline.result?.items?.length, paragraphsRead: plist.length, keys: Object.keys(paras.result ?? {}), find });

  // 3) replace_text ok
  const rep = `[CS]${find}`;
  const r3 = await call('replace_text', { find, replace: rep, occurrence: 1 });
  const hit = await call('search_text', { query: rep });
  rec('3_replace_ok', r3.ok && r3.result?.applied === true && hit.ok, { r3, searchKeys: Object.keys(hit.result ?? {}) , hit: JSON.stringify(hit.result).slice(0, 160) });
  const afterReplace = await state();

  // 4) stale target rejected
  const r4 = await call('replace_text', { find: '이문장은문서에절대없다-ZZZ-9f3a', replace: 'x' });
  const same = await state();
  rec('4_stale_rejected', r4.ok === false && !!r4.error?.code && same.textLen === afterReplace.textLen, { r4, unchanged: same.textLen === afterReplace.textLen });

  // 5) insert_table 3x3
  const cells = Array.from({ length: 9 }, (_, i) => `CSCELL${i + 1}`);
  const r5 = await call('insert_table', { position: 'end', columns: 3, cells });
  const s5 = await call('search_text', { query: 'CSCELL5' });
  const afterTable = await state();
  const tableFound = JSON.stringify(s5.result).includes('CSCELL5') && !/"(hits|matches|results)":\s*\[\s*\]/.test(JSON.stringify(s5.result));
  rec('5_insert_table', r5.ok && tableFound, { r5, textLen: afterTable.textLen, afterTable: afterTable.paragraphCounts });

  // 6) undo once -> table gone, replace remains
  const u = await page.evaluate(() => window.rhwpStudio.csAgentTools.undo());
  const s6 = await call('search_text', { query: 'CSCELL5' });
  const s6b = await call('search_text', { query: rep });
  const afterUndo = await state();
  const gone = !JSON.stringify(s6.result).includes('CSCELL5') || /"(hits|matches|results)":\s*\[\s*\]/.test(JSON.stringify(s6.result));
  const remains = JSON.stringify(s6b.result).includes(rep.slice(0, 4)) && afterUndo.textLen === afterReplace.textLen;
  rec('6_undo', u.ok && gone && remains, { u, tableGone: gone, replaceRemains: remains, textLenAfterUndo: afterUndo.textLen, expected: afterReplace.textLen });

  // 7) export -> reopen -> compare (원본과 같은 형식으로 왕복. hwp 원본의 hwpx 변환 차이는 참고값으로만 적는다)
  const exportAndReopen = async (format) => {
    const ex = await page.evaluate(async (format) => {
      const r = await window.rhwpStudio.csAgentTools.exportDocument(format);
      if (!r.ok) return r;
      let s = ''; const b = r.result.bytes; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return { ok: true, size: b.length, b64: btoa(s) };
    }, format);
    if (!ex.ok) return { ok: false, ex };
    const lr = await load(ex.b64, `exported.${format}`);
    await page.waitForTimeout(500);
    const post = await state();
    return { ok: lr.ok && post.textLen === afterUndo.textLen && post.pageCount === afterUndo.pageCount && (format !== name.split('.').pop() || name.endsWith('.hwp') || post.layoutLen === afterUndo.layoutLen), format, size: ex.size, loaded: lr.ok, pre: afterUndo, post };
  };
  const fmt = name.endsWith('.hwpx') ? 'hwpx' : 'hwp';
  const cmp = await exportAndReopen(fmt);
  rec('7_export_reopen', cmp.ok, cmp);
  if (fmt === 'hwp') {
    // 참고: 같은 상태를 다시 열어 hwpx 로 내보낸 결과(집계 제외)
    const cross = await exportAndReopen('hwpx');
    steps['7b_info_hwp_to_hwpx'] = { info: true, pass: cross.ok, ...cross };
    console.log('INFO 7b hwp->hwpx', JSON.stringify(cross).slice(0, 300));
  }

  // ───────────── 새 API(v2) 시나리오: 모두 독립 재읽기로 확인한다 ─────────────
  const fmtOf = name.endsWith('.hwpx') ? 'hwpx' : 'hwp';
  const reload = async () => {
    let lr = null;
    for (let i = 0; i < 20; i++) { lr = await load(b64, name); if (lr.ok) break; await page.waitForTimeout(300); }
    await page.waitForTimeout(300);
    return lr;
  };
  // 문서 서명: 모든 쪽 배치 글(표 칸 포함) + 모든 표 + 누름틀을 한 해시로. 바이트 해시는 export 로 따로 본다.
  const signature = () => within(page.evaluate(async () => {
    const A = window.hwpAgent;
    const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
    const info = (await A.callTool('get_document_info', {})).result;
    let layout = '';
    for (let pg = 1; pg <= info.pageCount; pg++) {
      let off = 0;
      for (;;) { const r = (await A.callTool('read_page_text', { page: pg, offset: off })).result; layout += r.text; if (!r.truncated) break; off = r.nextOffset; }
    }
    let body = '';
    for (let sec = 0; sec < info.sectionCount; sec++) {
      let from = 0;
      for (;;) { const r = (await A.callTool('read_paragraphs', { section: sec, from, count: 50 })).result; for (const p of r.paragraphs) body += p.text + '\n'; if (!r.truncated || r.nextFrom === undefined) break; from = r.nextFrom; }
    }
    const lt = (await A.callTool('list_tables', {})).result;
    const tables = [];
    for (const t of lt) tables.push((await A.callTool('read_table', { table: t.table })).result);
    const fields = (await A.callTool('list_fields', {})).result;
    return { pageCount: info.pageCount, layout: fnv(layout), layoutLen: layout.length, body: fnv(body), tables: fnv(JSON.stringify(tables)), tableCount: lt.length, fields: fnv(JSON.stringify(fields)) };
  }), 60000, 'signature');
  const exportHash = (format) => within(page.evaluate(async (format) => {
    const r = await window.hwpAgent.exportDocument(format);
    if (!r.ok) return null;
    const h = await crypto.subtle.digest('SHA-256', r.result.bytes);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, format), 60000, 'exportHash');
  const hcall = (tool, a, o) => within(page.evaluate(({ tool, a, o }) => window.hwpAgent.callTool(tool, a, o), { tool, a, o }), 60000, `hwpAgent.callTool ${tool}`);
  const eqj = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const layoutText = async () => (await page.evaluate(async () => {
    const A = window.hwpAgent; const info = (await A.callTool('get_document_info', {})).result; let t = '';
    for (let pg = 1; pg <= info.pageCount; pg++) { let off = 0; for (;;) { const r = (await A.callTool('read_page_text', { page: pg, offset: off })).result; t += r.text + '\n'; if (!r.truncated) break; off = r.nextOffset; } }
    return t;
  }));
  const squash = (x) => x.replace(/\s+/g, '');
  // 병합 없고 한 줄 칸만 있는 표 / 병합 있는 표를 고른다
  const pickTables = async () => {
    const lt = (await hcall('list_tables', {})).result;
    const plain = []; const merged = [];
    for (const t of lt) {
      const rt = (await hcall('read_table', { table: t.table })).result;
      if (!rt.merges.length && rt.rows >= 1 && rt.cols >= 2 && !rt.cells.flat().some((c) => c.includes('\n'))) plain.push({ t, rt });
      if (rt.merges.length) merged.push({ t, rt });
    }
    return { lt, plain, merged };
  };

  // 문서에 정확히 한 번 나오는 본문 글(표 밖)을 n 개 찾는다(앞 8·14·24 글자 중 유일한 것)
  const uniqueFinds = async (n) => {
    const out = [];
    for (let from = 0; from < 400 && out.length < n; from += 50) {
      const rp = await hcall('read_paragraphs', { section: 0, from, count: 50 });
      if (!rp.ok) break;
      for (const p of rp.result.paragraphs) {
        const t = (p.text ?? '').trim(); if (t.length < 8) continue;
        for (const len of [8, 14, 24]) {
          const f = [...t].slice(0, len).join('');
          if (f.length < len || /^\s|\s$/.test(f)) continue;
          const hit = (await hcall('search_text', { query: f })).result;
          if (hit.totalHits === 1 && !hit.hits[0].inTable && !out.includes(f)) { out.push(f); break; }
        }
        if (out.length >= n) break;
      }
      if (!rp.result.truncated && rp.result.nextFrom === undefined) break;
    }
    return out;
  };

  const lr0 = await reload();
  const sig0 = await signature();
  const hash0 = await exportHash(fmtOf);
  const picked = await pickTables();

  // a) list_tables / read_table 일치, set_cells → 재읽기 → export → 다시 열어 유지
  {
    const { lt, plain } = picked;
    const pageTables = await page.evaluate(async () => {
      const A = window.hwpAgent; const info = (await A.callTool('get_document_info', {})).result; let sum = 0;
      for (let pg = 1; pg <= info.pageCount; pg++) { let off = 0; let max = 0; for (;;) { const r = (await A.callTool('read_page_text', { page: pg, offset: off })).result; for (const m of r.text.matchAll(/\[table (\d+) \//g)) max = Math.max(max, Number(m[1])); if (!r.truncated) break; off = r.nextOffset; } sum += max; }
      return sum;
    });
    const lay = squash(await layoutText());
    const shapeOk = lt.every((t, i) => t.table === i && Number.isInteger(t.rows) && Number.isInteger(t.cols) && typeof t.hasMerge === 'boolean');
    let dimOk = true; let textSeen = 0; let textTotal = 0;
    for (const t of lt) {
      const rt = (await hcall('read_table', { table: t.table })).result;
      if (rt.rows !== t.rows || rt.cols !== t.cols || rt.cells.length !== t.rows || rt.cells.some((r) => r.length !== t.cols)) dimOk = false;
      if (rt.merges.length > 0 !== t.hasMerge) dimOk = false;
      for (const c of rt.cells.flat()) { const q = squash(c.split('\n')[0]); if (q && q.length <= 30) { textTotal++; if (lay.includes(q)) textSeen++; } }
    }
    const tA = plain[0];
    let cellOk = false; let detail = {};
    if (tA) {
      const row = tA.rt.rows - 1; const col = tA.rt.cols - 1; const text = `CS셀-${tA.t.table}-${row}-${col}`;
      const before = (await hcall('read_table', { table: tA.t.table })).result;
      const r = await hcall('set_cells', { table: tA.t.table, cells: [{ row, col, text }] });
      const after = (await hcall('read_table', { table: tA.t.table })).result;
      const changedOk = r.ok && r.result.changed.length === 1 && r.result.changed[0].oldText === before.cells[row][col] && r.result.changed[0].newText === text && r.result.verified === true;
      const readOk = after.cells[row][col] === text && before.cells.every((rr, i) => rr.every((c, j) => (i === row && j === col) || c === after.cells[i][j]));
      const layOk = squash(await layoutText()).includes(squash(text));
      // 내보내고 다시 연다(원본 형식 + hwpx)
      const rt = {};
      for (const f of [...new Set([fmtOf, 'hwpx'])]) {
        const ex = await page.evaluate(async (f) => { const x = await window.hwpAgent.exportDocument(f); if (!x.ok) return x; let s = ''; const b = x.result.bytes; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return { ok: true, b64: btoa(s) }; }, f);
        await load(ex.b64, `rt.${f}`); await page.waitForTimeout(300);
        const re = (await hcall('read_table', { table: tA.t.table })).result;
        rt[f] = ex.ok && re.cells[row][col] === text;
      }
      cellOk = changedOk && readOk && layOk && Object.values(rt).every(Boolean);
      detail = { table: tA.t.table, row, col, text, changedOk, readOk, layOk, roundTrip: rt, r: JSON.stringify(r).slice(0, 200) };
    }
    rec('9a_tables_set_cells_roundtrip', lr0.ok && lt.length > 0 && shapeOk && dimOk && !!tA && cellOk && (pageTables === 0 || lt.length > 0) && textTotal > 0 && textSeen / textTotal >= 0.9,
      { tables: lt.length, pageTables, shapeOk, dimOk, textSeen, textTotal, ...detail });
    if (lt.length !== pageTables) console.log('INFO 9a list_tables vs page marker count', lt.length, pageTables);
  }

  // b) 병합에 덮인 칸 → COVERED_BY_MERGE, 문서 그대로(서명·export 바이트)
  {
    await reload();
    const { merged, plain } = await pickTables();
    const m = merged[0];
    let ok = false; let detail = { mergedTables: merged.length };
    if (m) {
      const mg = m.rt.merges.find((x) => x.colSpan > 1 || x.rowSpan > 1);
      const cov = mg.colSpan > 1 ? { row: mg.row, col: mg.col + 1 } : { row: mg.row + 1, col: mg.col };
      const other = plain[0] ? { table: plain[0].t.table, cells: [{ row: 0, col: 0, text: 'x' }] } : null;
      const s1 = await signature(); const h1 = await exportHash(fmtOf);
      const r = await hcall('set_cells', { table: m.t.table, cells: [{ row: 0, col: 0, text: 'CS-좋은칸' }, { row: cov.row, col: cov.col, text: 'CS-덮인칸' }] });
      const r2 = await hcall('set_cells', { table: m.t.table, cells: [{ row: m.rt.rows, col: 0, text: 'x' }] });
      const r3 = await hcall('set_cells', { table: 9999, cells: [{ row: 0, col: 0, text: 'x' }] });
      const s2 = await signature(); const h2 = await exportHash(fmtOf);
      const msgOk = r.error?.message.includes(`row ${mg.row}, col ${mg.col}`);
      ok = r.ok === false && r.error?.code === 'COVERED_BY_MERGE' && !!msgOk && r2.error?.code === 'OUT_OF_RANGE' && r3.error?.code === 'TABLE_NOT_FOUND' && eqj(s1, s2) && h1 === h2 && !!h1;
      detail = { ...detail, table: m.t.table, merge: mg, covered: cov, code: r.error?.code, msg: r.error?.message, r2: r2.error?.code, r3: r3.error?.code, unchangedSig: eqj(s1, s2), unchangedBytes: h1 === h2 };
    }
    rec('9b_covered_by_merge_nothing_written', ok, detail);
  }

  // c) fill_fields: 있는 이름 + 없는 이름, 중복 이름(ambiguous)
  {
    await reload();
    const cands = await uniqueFinds(3);
    let ok = false; let detail = { cands: cands.length };
    if (cands.length >= 3) {
      const i1 = await hcall('insert_field', { after: cands[0], name: 'CSF_A', guide: '가' });
      const i2 = await hcall('insert_field', { after: cands[1], name: 'CSF_DUP', guide: '나' });
      const i3 = await hcall('insert_field', { after: cands[2], name: 'CSF_DUP', guide: '다' });
      const lf0 = (await hcall('list_fields', {})).result.fields;
      const sBefore = await signature();
      const r = await hcall('fill_fields', { values: { CSF_A: '채움값A', CSF_MISSING: 'x' } });
      const lf1 = (await hcall('list_fields', {})).result.fields;
      const a = lf1.find((f) => f.name === 'CSF_A');
      const fillOk = r.ok && r.result.filled.length === 1 && r.result.filled[0].name === 'CSF_A' && eqj(r.result.notFound, ['CSF_MISSING']) && r.result.ambiguous.length === 0 && r.result.verified === true && a?.value === '채움값A';
      const sMid = await signature();
      const r2 = await hcall('fill_fields', { values: { CSF_DUP: '중복' } });
      const sAfterAmb = await signature();
      const ambOk = r2.ok && r2.result.filled.length === 0 && r2.result.ambiguous.length === 1 && r2.result.ambiguous[0].name === 'CSF_DUP' && eqj(sMid, sAfterAmb);
      const r3 = await hcall('fill_fields', { values: { 'CSF_DUP[2]': '둘째' } });
      const lf3 = (await hcall('list_fields', {})).result.fields.filter((f) => f.name === 'CSF_DUP');
      const idxOk = r3.ok && r3.result.filled.length === 1 && lf3.length === 2 && lf3[1].value === '둘째' && lf3[0].value !== '둘째';
      // undo 1번 = fill_fields 1번 (CSF_DUP[2] 되돌림) → 한 번 더 = CSF_A 되돌림
      await page.evaluate(() => window.hwpAgent.undo());
      const lfU = (await hcall('list_fields', {})).result.fields;
      const undo1 = lfU.filter((f) => f.name === 'CSF_DUP')[1]?.value !== '둘째' && lfU.find((f) => f.name === 'CSF_A')?.value === '채움값A';
      await page.evaluate(() => window.hwpAgent.undo()); // 앞의 채우기 중 ambiguous 는 쓰기 0 이라 undo 항목이 없어야 하고, 이 undo 가 CSF_A 채우기를 되돌린다
      const lfU2 = (await hcall('list_fields', {})).result.fields;
      const undo2 = lfU2.find((f) => f.name === 'CSF_A')?.value === lf0.find((f) => f.name === 'CSF_A')?.value;
      ok = i1.ok && i2.ok && i3.ok && fillOk && ambOk && idxOk && undo1 && undo2 && eqj(sBefore.body, sBefore.body);
      detail = { ...detail, fillOk, ambOk, idxOk, undo1, undo2, r: JSON.stringify(r).slice(0, 250), r2: JSON.stringify(r2).slice(0, 200) };
    }
    rec('9c_fill_fields', ok, detail);
  }

  // d) run_plan: 3 valid + 1 bad → 변경 0 / 3 valid → 적용 → undo 1번으로 원복 / 실행 중 실패 → 전체 롤백
  {
    await reload();
    const s0 = await signature(); const h0 = await exportHash(fmtOf);
    const { plain } = await pickTables();
    const finds = await uniqueFinds(2);
    const tA = plain[0];
    let ok = false; let detail = { finds: finds.length, hasTable: !!tA };
    if (finds.length >= 2 && tA) {
      const cellR = tA.rt.rows - 1; const cellC = tA.rt.cols - 1;
      const sA = { tool: 'replace_text', args: { find: finds[0], replace: `PLAN1${finds[0]}` } };
      const sB = { tool: 'replace_text', args: { find: finds[1], replace: `PLAN2${finds[1]}` } };
      const sC = { tool: 'set_cells', args: { table: tA.t.table, cells: [{ row: cellR, col: cellC, text: 'PLAN3셀' }] } };
      const bad = { tool: 'replace_text', args: { find: '이문장은문서에절대없다-PLAN-9f3a', replace: 'x' } };
      const p1 = await hcall('run_plan', { steps: [sA, sB, sC, bad] });
      const s1 = await signature(); const h1 = await exportHash(fmtOf);
      const invalidOk = p1.ok === false && p1.result?.applied === false && p1.result.invalid?.length === 1 && p1.result.invalid[0].index === 3 && p1.result.invalid[0].code === 'TARGET_NOT_FOUND' && eqj(s0, s1) && h0 === h1;
      const dry = await hcall('run_plan', { steps: [sA, sB, sC], dryRun: true });
      const sD = await signature(); const hD = await exportHash(fmtOf);
      const dryOk = dry.ok && dry.result.applied === false && dry.result.dryRun === true && dry.result.valid === true && eqj(s0, sD) && h0 === hD;
      const p2 = await hcall('run_plan', { steps: [sA, sB, sC] });
      const hit1 = (await hcall('search_text', { query: `PLAN1${finds[0]}` })).result.totalHits;
      const hit2 = (await hcall('search_text', { query: `PLAN2${finds[1]}` })).result.totalHits;
      const rt = (await hcall('read_table', { table: tA.t.table })).result;
      const appliedOk = p2.ok && p2.result.applied === true && p2.result.steps.length === 3 && hit1 === 1 && hit2 === 1 && rt.cells[cellR][cellC] === 'PLAN3셀' && Number.isInteger(p2.result.pageCountBefore) && Number.isInteger(p2.result.pageCountAfter) && p2.result.verified === true;
      await page.evaluate(() => window.hwpAgent.undo());
      const sU = await signature(); const hU = await exportHash(fmtOf);
      const undoOk = eqj(s0, sU);
      // 실행 중 실패(사전 검증은 통과: 같은 find 를 두 번 바꾼다) → 롤백, 이후 편집 정상
      const rf = await hcall('run_plan', { steps: [{ tool: 'replace_text', args: { find: finds[0], replace: 'RB1' } }, { tool: 'replace_text', args: { find: finds[0], replace: 'RB2' } }] });
      const sR = await signature(); const hR = await exportHash(fmtOf);
      const rollbackOk = rf.ok === false && rf.result?.applied === false && rf.result.failedAt === 1 && rf.result.rolledBack === true && eqj(s0, sR) && h0 === hR;
      const after = await hcall('replace_text', { find: finds[1], replace: `OK${finds[1]}` });
      const editOk = after.ok && after.result.verified === true;
      ok = invalidOk && dryOk && appliedOk && undoOk && rollbackOk && editOk;
      detail = { ...detail, undoBytesEqual: h0 === hU, invalidOk, dryOk, appliedOk, undoOk, rollbackOk, editOk, p1: JSON.stringify(p1).slice(0, 300), rf: JSON.stringify(rf).slice(0, 300), undoSteps: 1 };
    }
    rec('9d_run_plan_atomic', ok, detail);
  }

  // e) dryRun: replace_text / set_cells 는 문서를 바꾸지 않는다(서명 + export 바이트)
  {
    await reload();
    const s0 = await signature(); const h0 = await exportHash(fmtOf);
    const { plain } = await pickTables();
    const find = (await uniqueFinds(1))[0] ?? null;
    let ok = false; let detail = {};
    if (find && plain[0]) {
      const tA = plain[0]; const row = 0; const col = tA.rt.cols - 1;
      const d1 = await hcall('replace_text', { find, replace: `DRY${find}` }, { dryRun: true });
      const d2 = await hcall('set_cells', { table: tA.t.table, cells: [{ row, col, text: 'DRY셀' }] }, { dryRun: true });
      const d4 = await hcall('replace_text', { find: '이문장은문서에절대없다-DRY-1', replace: 'x' }, { dryRun: true });
      const d5 = await hcall('fill_fields', { values: { NOPE: 'x' } }, { dryRun: true });
      const s1 = await signature(); const h1 = await exportHash(fmtOf);
      const dOk = d1.ok && d1.result.dryRun === true && d1.result.applied === false && d1.result.newText === `DRY${find}` && d1.result.oldText === find
        && d2.ok && d2.result.dryRun === true && d2.result.changed.length === 1 && d2.result.changed[0].newText === 'DRY셀'
        && d4.ok === false && d4.error.code === 'TARGET_NOT_FOUND' && d5.ok && d5.result.notFound[0] === 'NOPE';
      ok = dOk && eqj(s0, s1) && h0 === h1 && !!h0;
      // dryRun 뒤에도 진짜 호출은 한 번에 적용되고 verified 가 true
      const real = await hcall('replace_text', { find, replace: `DRY${find}` });
      ok = ok && real.ok && real.result.verified === true && (await hcall('search_text', { query: `DRY${find}` })).result.totalHits === 1;
      // set_cells 는 undo 1번으로 되돌아온다
      const tb = (await hcall('read_table', { table: tA.t.table })).result;
      const sc = await hcall('set_cells', { table: tA.t.table, cells: [{ row: 0, col, text: 'UNDO셀' }, { row: 1, col, text: 'UNDO셀2' }] });
      await page.evaluate(() => window.hwpAgent.undo());
      const ta = (await hcall('read_table', { table: tA.t.table })).result;
      const undoSetCells = sc.ok && sc.result.verified === true && eqj(tb.cells, ta.cells);
      ok = ok && undoSetCells;
      detail = { undoSetCells, dOk, unchangedSig: eqj(s0, s1), unchangedBytes: h0 === h1, d1: JSON.stringify(d1).slice(0, 200) };
    }
    rec('9e_dryrun_no_change', ok, detail);
  }

  // f) help / listTools / hwpAgent / meta
  {
    const r = await page.evaluate(async () => {
      const help = await window.hwpAgent.help();
      const tools = await window.hwpAgent.listTools();
      const viaOld = await window.rhwpStudio.csAgentTools.callTool('get_document_info', {});
      const viaNew = await window.hwpAgent.callTool('get_document_info', {});
      const meta = document.querySelector('meta[name="ai-agent-api"]')?.getAttribute('content') ?? null;
      return { help, names: tools.map((t) => t.name), alias: JSON.stringify(viaOld) === JSON.stringify(viaNew) && viaNew.ok, meta };
    });
    const NEW = ['list_tables', 'read_table', 'set_cells', 'fill_fields', 'run_plan'];
    const missing = r.names.filter((n) => !r.help.includes(n));
    rec('9f_help_discovery', typeof r.help === 'string' && r.help.length > 500 && r.help.length < 6000 && missing.length === 0 && NEW.every((n) => r.names.includes(n)) && r.alias
      && r.meta === 'window.hwpAgent — call await hwpAgent.help()' && /get_document_info/.test(r.help) && /COVERED_BY_MERGE/.test(r.help),
      { helpLen: r.help.length, missing, alias: r.alias, meta: r.meta, tools: r.names.length });
  }

  // g) 플러그인 지연 로드 + meta 는 호출 전에 이미 있다 + WebMCP 등록(기능 감지, 던지지 않음)
  if (name.endsWith('.hwpx')) {
    const mk = async (initScript) => {
      const c = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      if (initScript) await c.addInitScript(initScript);
      const pg = await c.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
      await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await pg.waitForFunction(() => window.hwpAgent && document.querySelector('meta[name="ai-agent-api"]'), null, { timeout: 30000 });
      return { c, pg, errs };
    };
    // 호출 전: meta 있음, 플러그인 청크는 아직 안 받음
    const a = await mk(null);
    await a.pg.waitForTimeout(1500);
    const lazy = await a.pg.evaluate(() => ({ meta: document.querySelector('meta[name="ai-agent-api"]')?.content, loaded: performance.getEntriesByType('resource').some((e) => /agent-tools-plugin/.test(e.name)) }));
    await a.c.close();
    // WebMCP 있음
    const b = await mk(() => { window.__mcp = []; Object.defineProperty(document, 'modelContext', { value: { registerTool(t) { window.__mcp.push(t); } }, configurable: true }); });
    await b.pg.waitForFunction(() => window.__mcp.length >= 45, null, { timeout: 30000 }).catch(() => {});
    const mcp = await b.pg.evaluate(async () => {
      const names = window.__mcp.map((t) => t.name);
      const t = window.__mcp.find((x) => x.name === 'list_tables');
      let exec = null; try { const r = await t.execute({}); exec = JSON.parse(r.content[0].text); } catch (e) { exec = String(e); }
      return { count: names.length, schemaOk: window.__mcp.every((x) => x.description && x.inputSchema?.type === 'object' && typeof x.execute === 'function'), exec: typeof exec === 'object' ? { ok: exec.ok, err: exec.error?.code } : exec };
    });
    await b.c.close();
    // WebMCP 가 던져도 편집기 정상
    const d = await mk(() => { Object.defineProperty(document, 'modelContext', { value: { registerTool() { throw new Error('boom'); } }, configurable: true }); });
    await d.pg.waitForTimeout(3000);
    const dres = await d.pg.evaluate(async () => (await window.hwpAgent.listTools()).length);
    await d.c.close();
    rec('9g_lazy_meta_webmcp', lazy.meta === 'window.hwpAgent — call await hwpAgent.help()' && lazy.loaded === false && mcp.count === 45 && mcp.schemaOk && mcp.exec && mcp.exec.ok !== undefined && b.errs.length === 0 && dres === 45 && d.errs.length === 0 && a.errs.length === 0,
      { lazy, mcp, throwingRegisterErrs: d.errs.slice(0, 2), listToolsAfterThrow: dres });
  }

  // 8) no modal left
  const modals = await page.evaluate(() => [...document.querySelectorAll('.modal-overlay, dialog[open]')].filter((e) => e.offsetParent !== null || e.tagName === 'DIALOG').length);
  rec('8_no_modal', modals === 0 && errors.length === 0, { modals, pageErrors: errors.slice(0, 3) });

  await ctx.close();
  return steps;
}

// ───────────── 추가 시나리오: 공백 관용 찾기(10), 「AI에게 맡기기」 버튼(11) ─────────────
async function runExtras() {
  const rel = 'samples/156636617_240617 2024년 5월 월간 수출입 현황(확정치).hwp';
  const steps = {};
  const rec = (name, pass, detail) => { steps[name] = { pass: !!pass, ...detail }; report[pass ? 'passed' : 'failed']++; console.log(`${pass ? 'PASS' : 'FAIL'} [extras] ${name}`, JSON.stringify(detail ?? {}).slice(0, 400)); };
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.hwpAgent && document.getElementById('menu-bar'), null, { timeout: 30000 });
  const b64 = loadSample(rel).toString('base64');
  const load = async () => {
    let r = null;
    for (let i = 0; i < 20; i++) {
      r = await within(page.evaluate(async (b) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return await window.hwpAgent.loadDocument(u, 'ws.hwp'); }, b64), 90000, 'load');
      if (r.ok) break; await page.waitForTimeout(500);
    }
    await page.waitForTimeout(300); return r;
  };
  const hc = (tool, a, o) => within(page.evaluate(({ tool, a, o }) => window.hwpAgent.callTool(tool, a, o), { tool, a, o }), 120000, `callTool ${tool}`);
  const EXACT = '(단위\u2007: 백만 달러, %)';
  const NORMAL = '(단위 : 백만 달러, %)';
  const para = async (r) => { // 결과 위치의 문단을 다시 읽는다
    const loc = r.result.location; const rp = await hc('read_paragraphs', { section: loc.section, from: loc.paragraph, count: 1 }); return rp.result.paragraphs[0].text;
  };

  // 10) 공백 관용 찾기
  {
    const l = await load();
    const exactHits = (await hc('search_text', { query: EXACT })).result;
    const normHits = (await hc('search_text', { query: NORMAL })).result;
    const N = exactHits.totalHits;
    const occ = N > 1 ? { occurrence: 1 } : {};
    const hintOk = normHits.totalHits === 0 && normHits.normalizedMatches?.[0]?.matchedText === EXACT;
    const amb = N > 1 ? await hc('replace_text', { find: NORMAL, replace: 'x' }) : null;
    const ambOk = N > 1 ? (amb.ok === false && amb.error.code === 'AMBIGUOUS_TARGET') : true;
    const dry = await hc('replace_text', { find: NORMAL, replace: 'WS교체(단위)', ...occ }, { dryRun: true });
    const dryOk = dry.ok && dry.result.dryRun === true && dry.result.normalizedMatch === true && dry.result.matchedText === EXACT && dry.result.oldText === EXACT;
    const real = await hc('replace_text', { find: NORMAL, replace: 'WS교체(단위)', ...occ });
    const after = real.ok ? await para(real) : '';
    const realOk = real.ok && real.result.normalizedMatch === true && real.result.matchedText === EXACT && real.result.verified === true && after.includes('WS교체(단위)') && !after.includes(EXACT);
    const stale = await hc('replace_text', { find: '이 문장은 문서에 절대 없다 9f3a', replace: 'x' });
    const staleOk = stale.ok === false && stale.error.code === 'TARGET_NOT_FOUND';
    // 정확히 맞는 경우는 normalizedMatch 가 없다
    await load();
    const ex = await hc('replace_text', { find: EXACT, replace: 'EXACT교체', ...occ });
    const exOk = ex.ok && !('normalizedMatch' in ex.result) && !('matchedText' in ex.result) && (await para(ex)).includes('EXACT교체');
    rec('10a_whitespace_replace', l.ok && N >= 1 && hintOk && ambOk && dryOk && realOk && staleOk && exOk, { exactHits: N, hintOk, ambOk, dryOk, realOk, staleOk, exOk, after: after.slice(0, 80), real: JSON.stringify(real).slice(0, 220) });

    // run_plan 안의 단계도 같은 규칙(사전 검증 + 적용 + 재읽기)
    await load();
    const step = { tool: 'replace_text', args: { find: NORMAL, replace: 'PLAN교체(단위)', ...occ } };
    const pd = await hc('run_plan', { steps: [step], dryRun: true });
    const pa = await hc('run_plan', { steps: [step] });
    const hit = (await hc('search_text', { query: 'PLAN교체(단위)' })).result.totalHits;
    const planOk = pd.ok && pd.result.valid === true && pd.result.steps[0].preview.normalizedMatch === true && pa.ok && pa.result.applied === true
      && pa.result.steps[0].normalizedMatch === true && pa.result.steps[0].matchedText === EXACT && pa.result.verified === true && hit === 1;
    // 다른 도구의 인자(insert_field 의 after)에도 적용되는지
    await load();
    const fld = await hc('insert_field', { after: NORMAL, name: 'WS_F', guide: 'g', ...occ });
    const fldOk = fld.ok && fld.result.normalizedMatch === true && (await hc('list_fields', {})).result.fields.some((f) => f.name === 'WS_F');
    rec('10b_whitespace_run_plan_and_other_args', planOk && fldOk, { planOk, fldOk, fld: JSON.stringify(fld).slice(0, 260) });
  }

  // 11) 「AI에게 맡기기」 버튼
  {
    const info = await page.evaluate(() => {
      const b = document.getElementById('cs-ai-handoff'); const bar = document.getElementById('menu-bar');
      const r = b?.getBoundingClientRect(); const br = bar.getBoundingClientRect();
      const rect = (id) => { const e = document.getElementById(id); const x = e.getBoundingClientRect(); return [x.x, x.y, x.width, x.height].map(Math.round).join(','); };
      return { exists: !!b, visible: !!b && b.offsetWidth > 0 && b.offsetHeight > 0, text: b?.textContent, inBar: bar.contains(b), within: !!r && r.right <= br.right + 0.5 && r.bottom <= br.bottom + 0.5, before: [rect('scroll-container'), rect('editor-area'), rect('icon-toolbar'), rect('status-bar')], prompt: window.hwpAgent.agentPrompt, style: getComputedStyle(b).fontFamily === getComputedStyle(document.querySelector('.menu-title')).fontFamily };
    });
    await page.click('#cs-ai-handoff');
    await page.waitForSelector('#cs-ai-handoff .cs-toast', { timeout: 3000 });
    const toast = await page.textContent('#cs-ai-handoff .cs-toast');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    await page.waitForFunction(() => !document.querySelector('#cs-ai-handoff .cs-toast'), null, { timeout: 5000 });
    // 버튼을 걷어도 문서 영역 위치가 같다(= 레이아웃을 밀지 않는다)
    const noShift = await page.evaluate((before) => {
      document.getElementById('cs-ai-handoff').remove();
      const rect = (id) => { const e = document.getElementById(id); const x = e.getBoundingClientRect(); return [x.x, x.y, x.width, x.height].map(Math.round).join(','); };
      return JSON.stringify(before) === JSON.stringify(['scroll-container', 'editor-area', 'icon-toolbar', 'status-bar'].map(rect));
    }, info.before);
    rec('11a_handoff_button', info.exists && info.visible && info.inBar && info.within && info.style && info.text.includes('AI에게 맡기기') && clip === info.prompt && /^이 탭\(편집기\)의 문서는/.test(info.prompt) && /복사했어요/.test(toast) && noShift,
      { info: { ...info, prompt: undefined }, clipOk: clip === info.prompt, toast, noShift });
    // 클립보드 API 가 없을 때 execCommand 대체 경로 + 좁은 화면
    const ctx2 = await browser.newContext({ viewport: { width: 400, height: 800 } });
    await ctx2.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); window.__copied = null; document.addEventListener('copy', () => { window.__copied = document.getSelection().toString(); }); });
    const p2 = await ctx2.newPage(); const errs2 = []; p2.on('pageerror', (e) => errs2.push(String(e)));
    await p2.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p2.waitForSelector('#cs-ai-handoff', { timeout: 30000 });
    const narrow = await p2.evaluate(() => { const b = document.getElementById('cs-ai-handoff'); return { w: b.offsetWidth, label: [...b.children].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.textContent).join(''), overflowX: document.documentElement.scrollWidth > window.innerWidth }; });
    await p2.click('#cs-ai-handoff');
    await p2.waitForSelector('#cs-ai-handoff .cs-toast', { timeout: 3000 });
    const fb = await p2.evaluate(() => ({ toast: document.querySelector('#cs-ai-handoff .cs-toast').textContent, copied: window.__copied, prompt: window.hwpAgent.agentPrompt }));
    await ctx2.close();
    rec('11b_handoff_fallback_narrow', narrow.w > 0 && narrow.label === 'AI' && !narrow.overflowX && /복사/.test(fb.toast) && fb.copied === fb.prompt && errs2.length === 0, { narrow, fb: { toast: fb.toast, copiedOk: fb.copied === fb.prompt }, errs2 });
  }

  rec('12_extras_no_page_errors', errors.length === 0, { errors: errors.slice(0, 3) });
  await ctx.close();
  report.samples.extras = steps;
}

try {
  for (const rel of samples) {
    try { report.samples[rel] = await runSample(rel); }
    catch (e) { report.failed++; report.samples[rel] = { exception: { pass: false, message: String(e).slice(0, 500) } }; console.log('EXC', rel, e); }
  }
} finally {
  try { await runExtras(); } catch (e) { report.failed++; report.samples.extras = { exception: { pass: false, message: String(e).slice(0, 500) } }; console.log('EXC extras', e); }
  await browser.close(); server.close();
}
report.finishedAt = new Date().toISOString();
writeFileSync(join(here, 'agent-tools.report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, failed: report.failed }, null, 2));
process.exit(report.failed === 0 ? 0 : 1);
