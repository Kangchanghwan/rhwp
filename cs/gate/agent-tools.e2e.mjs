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
  : ['samples/HWP5-nopassword-123456.hwpx', 'samples/HWP5-nopassword-123456.hwp'];
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
  }, { b, n }), 30000, 'loadDocument');
  const call = (tool, a, o) => within(page.evaluate(({ tool, a, o }) => window.rhwpStudio.csAgentTools.callTool(tool, a, o), { tool, a, o }), 30000, `callTool ${tool}`);
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
  rec('1_listTools', counts.read === 8 && counts.write === 29 && counts.command === 3 && shapeOk && !tools.some((t) => t.name === 'create_document'),
    { counts, names: byGroup, nonHeadless: tools.filter((t) => !t.headless).map((t) => t.name) });

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

  // 8) no modal left
  const modals = await page.evaluate(() => [...document.querySelectorAll('.modal-overlay, dialog[open]')].filter((e) => e.offsetParent !== null || e.tagName === 'DIALOG').length);
  rec('8_no_modal', modals === 0 && errors.length === 0, { modals, pageErrors: errors.slice(0, 3) });

  await ctx.close();
  return steps;
}

try {
  for (const rel of samples) {
    try { report.samples[rel] = await runSample(rel); }
    catch (e) { report.failed++; report.samples[rel] = { exception: { pass: false, message: String(e).slice(0, 500) } }; console.log('EXC', rel, e); }
  }
} finally {
  await browser.close(); server.close();
}
report.finishedAt = new Date().toISOString();
writeFileSync(join(here, 'agent-tools.report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, failed: report.failed }, null, 2));
process.exit(report.failed === 0 ? 0 : 1);
