#!/usr/bin/env node
/**
 * Gate: serve out/ (the studio) on one localhost port and gate/host.html on another, embed
 * the studio cross-origin with @rhwp/editor createStudio(), and run a round trip:
 *   new blank document -> export HWPX -> load those bytes -> hwpctrl.batch insert text ->
 *   exportBytes -> re-open -> text present (also checked by unzipping the bytes in Node).
 * Network checks: no non-localhost request, no 4xx/5xx, no failed request, no request for
 * an excluded font, no service worker, CSP frame-ancestors header present.
 *
 * The studio server applies out/_headers and compresses with brotli like an edge would,
 * so the reported transfer size approximates a first open.
 *
 * Usage: node gate/run.mjs [--headed]     writes gate/report.json, exits 1 on failure
 */
import http from 'node:http'
import { brotliCompressSync, inflateRawSync, constants as zc } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, 'out')
const up = { ...JSON.parse(readFileSync(join(root, 'build', 'config.json'), 'utf8')), ...JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8')) }
mkdirSync(join(root, '.cache'), { recursive: true })
const DEADLINE_MS = 240_000
const MARKER = `cs gate ${Date.now().toString(36)} 한글 확인`

if (!existsSync(join(outDir, 'index.html'))) {
  console.error('[gate] out/ 이 없습니다. 먼저 node cs/build/build.mjs 를 실행하세요.')
  process.exit(1)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf', '.ts': 'text/plain; charset=utf-8',
}
const COMPRESSIBLE = /\.(html|js|mjs|css|json|wasm|svg|txt|md|ttf|otf|ico)$/

/** Minimal Cloudflare Pages _headers parser: path patterns with a trailing or inner '*'. */
function parseHeaders(text) {
  const rules = []
  let cur = null
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: [] }; rules.push(cur); continue }
    const i = line.indexOf(':')
    cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()])
  }
  return rules.map((r) => ({ ...r, re: new RegExp('^' + r.pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$') }))
}

function staticServer(dir, { headerRules = [], brotli = false, extra = {} } = {}) {
  const cache = new Map()
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let pathname = decodeURIComponent(url.pathname)
    let file = null
    for (const [prefix, base] of Object.entries(extra)) {
      if (pathname.startsWith(prefix)) file = join(base, pathname.slice(prefix.length))
    }
    if (!file) {
      const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
      file = join(dir, rel)
      if (pathname.endsWith('/')) file = join(file, 'index.html')
    }
    if (!file.startsWith(resolve(dir)) && !Object.values(extra).some((b) => file.startsWith(resolve(b)))) {
      res.writeHead(403); res.end(); return
    }
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return }
    const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }
    for (const r of headerRules) if (r.re.test(pathname)) for (const [k, v] of r.headers) headers[k] = headers[k] ? `${headers[k]}, ${v}` : v
    let body = readFileSync(file)
    if (brotli && COMPRESSIBLE.test(file) && /\bbr\b/.test(req.headers['accept-encoding'] || '')) {
      if (!cache.has(file)) cache.set(file, brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 5, [zc.BROTLI_PARAM_SIZE_HINT]: body.length } }))
      body = cache.get(file)
      headers['Content-Encoding'] = 'br'
    }
    headers['Content-Length'] = body.length
    res.writeHead(200, headers)
    res.end(body)
  })
}

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)))

/** Read one entry from a zip (central directory walk, stored or deflate). */
function unzipEntry(buf, name) {
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('zip: no end of central directory')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nlen = buf.readUInt16LE(p + 28)
    const xlen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen)
    names.push(entry)
    if (entry === name) {
      const lnlen = buf.readUInt16LE(local + 26)
      const lxlen = buf.readUInt16LE(local + 28)
      const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize)
      return { names, data: method === 0 ? data : inflateRawSync(data) }
    }
    p += 46 + nlen + xlen + clen
  }
  return { names, data: null }
}

/** All entries of a zip (stored or deflate). */
function unzipAll(buf) {
  const { names } = unzipEntry(buf, '\u0000')
  return names.map((name) => ({ name, data: unzipEntry(buf, name).data }))
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Write a zip with stored (uncompressed) entries, in the given order. */
function zipStored(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const report = { startedAt: new Date().toISOString(), upstream: { tag: up.tag, commit: up.commit }, checks: {}, errors: [] }
const fail = (msg) => { report.errors.push(msg) }

const headerRules = parseHeaders(readFileSync(join(outDir, '_headers'), 'utf8'))
const studioSrv = staticServer(outDir, { headerRules, brotli: true })
const hostSrv = staticServer(here, { extra: { '/node_modules/@rhwp/editor/': join(root, 'node_modules', '@rhwp', 'editor'), '/agent/': join(root, 'agent') } })
const studioPort = await listen(studioSrv)
const hostPort = await listen(hostSrv)
const studioOrigin = `http://127.0.0.1:${studioPort}`
const hostOrigin = `http://127.0.0.1:${hostPort}`
report.studioOrigin = studioOrigin
report.hostOrigin = hostOrigin

const editorPkg = JSON.parse(readFileSync(join(root, 'node_modules', '@rhwp', 'editor', 'package.json'), 'utf8'))
report.editorVersion = editorPkg.version
if (editorPkg.version !== up.editorVersion) fail(`@rhwp/editor ${editorPkg.version} 가 cs/build/config.json editorVersion ${up.editorVersion} 과 다릅니다`)

const excluded = Object.keys(up.excludedFonts)
// family names that the upstream font rules attach to the excluded files (used to build a test document)
const EXCLUDED_FAMILIES = ['Cafe24 Ssurround Bold', '카페24 써라운드', 'Cafe24 Supermagic', '카페24 슈퍼매직',
  'Happiness Sans Regular', '해피니스 산스 레귤러', 'Happiness Sans Bold', '해피니스 산스 볼드',
  'Happiness Sans Title', '해피니스 산스 타이틀', 'Happiness Sans VF', '해피니스 산스 VF']
const requests = []
const consoleErrors = []
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const killer = setTimeout(() => { fail(`전체 제한 시간 ${DEADLINE_MS / 1000}초 초과`); finish() }, DEADLINE_MS)
let finished = false

async function finish() {
  if (finished) return
  finished = true
  clearTimeout(killer)
  report.finishedAt = new Date().toISOString()
  report.ok = report.errors.length === 0
  writeFileSync(join(here, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`[gate] ${report.ok ? '통과' : '실패'} (gate/report.json)`)
  for (const e of report.errors) console.log(`[gate]  - ${e}`)
  await browser.close().catch(() => {})
  studioSrv.close(); hostSrv.close()
  process.exit(report.ok ? 0 : 1)
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`))
  page.on('requestfinished', async (req) => {
    const resp = await req.response().catch(() => null)
    const sizes = await req.sizes().catch(() => null)
    requests.push({ url: req.url(), status: resp ? resp.status() : null, frame: req.frame()?.url().slice(0, 80) ?? null,
      bodyBytes: sizes ? sizes.responseBodySize : null, encoding: resp ? (await resp.allHeaders().catch(() => ({})))['content-encoding'] || null : null })
  })
  page.on('requestfailed', (req) => requests.push({ url: req.url(), status: null, failed: req.failure()?.errorText || 'failed' }))

  const hostUrl = `${hostOrigin}/host.html?studio=${encodeURIComponent(studioOrigin + '/')}&marker=${encodeURIComponent(MARKER)}`
  // page.goto against local servers can hang after the 200, so only wait for commit
  await page.goto(hostUrl, { waitUntil: 'commit', timeout: 15_000 })
  const t0 = Date.now()
  await page.waitForFunction(() => window.__gate && window.__gate.done, null, { timeout: 180_000, polling: 250 })
  const g = await page.evaluate(() => { const { exportedBase64, ...rest } = window.__gate; return { ...rest, exportedBase64 } })
  report.roundTripSeconds = Math.round((Date.now() - t0) / 100) / 10
  report.steps = g.steps
  if (!g.ok) fail(`라운드트립 실패: ${g.error}`)
  else {
    report.checks.markerViaHwpCtrlAfterReload = g.markerInTextAfterReload
    if (!g.markerInTextAfterReload) fail('다시 연 문서의 GetTextFile 에 넣은 글이 없습니다')
    const bytes = Buffer.from(g.exportedBase64, 'base64')
    writeFileSync(join(root, '.cache', 'gate-roundtrip.hwpx'), bytes)
    const mime = unzipEntry(bytes, 'mimetype')
    const sec = unzipEntry(bytes, 'Contents/section0.xml')
    report.checks.exportedHwpx = { bytes: bytes.length, mimetype: mime.data?.toString('utf8') ?? null, entries: sec.names }
    report.checks.markerInSection0Xml = !!sec.data && sec.data.toString('utf8').includes(MARKER)
    if (mime.data?.toString('utf8') !== 'application/hwp+zip') fail('내보낸 HWPX 의 mimetype 이 application/hwp+zip 이 아닙니다')
    if (!report.checks.markerInSection0Xml) fail('내보낸 HWPX 의 Contents/section0.xml 에 넣은 글이 없습니다')
    report.checks.pageCount = g.pageCount

    // agent (다른 출처 postMessage 창구)
    const ag = g.agent || {}
    report.checks.agent = ag
    if (!g.agent) fail('에이전트 단계 결과가 없습니다')
    else {
      if (!(ag.outlineCount >= 1)) fail('agent.outline 이 문단을 돌려주지 않았습니다')
      if (ag.expectMismatch !== 'EXPECT_MISMATCH') fail(`agent.replaceParagraph expect 불일치가 거절되지 않았습니다: ${ag.expectMismatch}`)
      if (!ag.table || !ag.table.same || ag.table.rows !== 4 || ag.table.cols !== 4) fail('agent.insertTable 4x4 칸 글이 다릅니다')
      if (!ag.editUndo || !ag.editUndo.oneStep) fail(`agent.edit + undo 가 한 단계가 아닙니다: ${JSON.stringify(ag.editUndo)}`)
      if (!ag.reopen || !ag.reopen.sameTexts || !ag.reopen.tableSame || ag.reopen.pages1 !== ag.reopen.pages2) fail(`내보낸 뒤 다시 연 문서가 다릅니다: ${JSON.stringify(ag.reopen)}`)
      if (ag.tablesAfterDelete !== 0) fail('agent.deleteObject 뒤에도 표가 남았습니다')
      if (ag.dialogs && ag.dialogs.length) fail(`대화상자가 떠 있습니다: ${ag.dialogs.join(', ')}`)
      if (ag.unknown !== 'UNKNOWN_METHOD') fail(`목록에 없는 함수가 거절되지 않았습니다: ${ag.unknown}`)
    }

    // Font mapping: rename the fonts of the round-trip document to the excluded families,
    // load it, and record which font files the studio fetches for them.
    const entries = unzipAll(bytes)
    const header = entries.find((e) => e.name === 'Contents/header.xml')
    let i = 0
    header.data = Buffer.from(header.data.toString('utf8').replace(/(<hh:font id="\d+" face=")[^"]*"/g,
      (_, pre) => `${pre}${EXCLUDED_FAMILIES[i++ % EXCLUDED_FAMILIES.length]}"`), 'utf8')
    report.checks.fontDocRenamedFaces = i
    const fontDoc = zipStored(entries)
    await page.waitForTimeout(500)
    const before = requests.length
    report.firstOpen = {
      note: '편집기 부팅부터 합성 문서 왕복까지 studio origin 응답 본문 바이트 (brotli quality 5, woff2 는 그대로)',
      requests: requests.filter((r) => r.url.startsWith(studioOrigin)).length,
      bodyBytes: requests.filter((r) => r.url.startsWith(studioOrigin)).reduce((a, r) => a + (r.bodyBytes || 0), 0),
    }
    const fontLoad = await page.evaluate((b64) => window.__gateLoad(b64), fontDoc.toString('base64'))
    await page.waitForTimeout(3000)
    const fontReqs = requests.slice(before).filter((r) => r.url.includes('/fonts/')).map((r) => r.url.replace(studioOrigin, ''))
    report.checks.fontDoc = { ...fontLoad, fontRequests: fontReqs }
    if (!fontLoad.text.includes(MARKER)) fail('글꼴 이름을 바꾼 문서를 열었는데 본문 글이 없습니다')
    if (!fontReqs.some((u) => /Pretendard-(Regular|Bold|ExtraBold)\.woff2/.test(u))) fail('제외 글꼴 이름이 대체 글꼴(Pretendard)로 이어지지 않았습니다')
  }

  // 저장소 샘플 열기 -> 고치기 -> 내보내기 -> 다시 열기
  if (!report.errors.length) {
    report.checks.samples = []
    for (const rel of ['rhwp-studio/public/samples/form-002.hwpx', 'rhwp-studio/public/samples/biz_plan.hwp']) {
      const file = join(root, '..', rel)
      if (!existsSync(file)) { fail(`샘플이 없습니다: ${rel}`); continue }
      const r = await page.evaluate(([b64, name, mark]) => window.__gateSample(b64, name, mark),
        [readFileSync(file).toString('base64'), rel.split('/').pop(), MARKER + ' sample'])
      report.checks.samples.push(r)
      if (!(r.pages >= 1)) fail(`샘플 ${r.name} 을 열었는데 쪽이 없습니다`)
      if (!(r.textBefore > 0)) fail(`샘플 ${r.name} 본문이 비어 있습니다`)
      if (!r.hasMarkerEdited) fail(`샘플 ${r.name} 에 넣은 글이 편집 직후 보이지 않습니다`)
      if (!(r.exportedBytes > 0) || !(r.pagesAfter >= 1) || !r.hasMarkerAfterReload) fail(`샘플 ${r.name} 내보내기 후 다시 열기가 실패했습니다: ${JSON.stringify(r)}`)
    }
  }

  // service worker and CSP checks inside the cross-origin studio frame
  const studioFrame = page.frames().find((f) => f.url().startsWith(studioOrigin))
  if (!studioFrame) fail('studio iframe 을 찾지 못했습니다')
  else {
    report.checks.themeAfterCommands = await studioFrame.evaluate(() => ({
      mode: document.documentElement.dataset.themeMode,
      effective: document.documentElement.dataset.themeEffective,
      skin: document.documentElement.dataset.themeSkin || 'default',
    }))
    const th = report.checks.themeAfterCommands
    if (th.effective !== 'dark' || th.skin !== 'flat') fail(`테마 커맨드가 적용되지 않았습니다: ${JSON.stringify(th)}`)
    report.checks.serviceWorkers = await studioFrame.evaluate(async () =>
      navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0)
    if (report.checks.serviceWorkers !== 0) fail(`service worker 가 ${report.checks.serviceWorkers}개 등록됐습니다`)
  }
  const idxResp = await fetch(studioOrigin + '/')
  report.checks.csp = idxResp.headers.get('content-security-policy')
  report.checks.indexCacheControl = idxResp.headers.get('cache-control')
  if (!/frame-ancestors https:\/\/clipboardapp\.org https:\/\/www\.clipboardapp\.org/.test(report.checks.csp || '')) fail('index.html 응답에 frame-ancestors CSP 가 없습니다')
  if (report.checks.indexCacheControl !== 'no-cache') fail('index.html 이 no-cache 가 아닙니다')
  const missing = await fetch(studioOrigin + '/fonts/' + excluded[0])
  report.checks.excludedFontHttpStatus = missing.status
  if (missing.status !== 404) fail(`제외한 글꼴 파일이 ${missing.status} 로 응답합니다`)
  await page.waitForTimeout(1500) // let late font requests finish
} catch (e) {
  fail(`예외: ${String(e && e.stack || e).slice(0, 800)}`)
}

// network checks
const isLocal = (u) => { try { const x = new URL(u); return !/^https?:$/.test(x.protocol) || ['127.0.0.1', 'localhost'].includes(x.hostname) } catch { return true } }
const external = requests.filter((r) => !isLocal(r.url)).map((r) => r.url)
const bad = requests.filter((r) => r.status !== null && r.status >= 400).map((r) => `${r.status} ${r.url}`)
const failed = requests.filter((r) => r.failed).map((r) => `${r.failed} ${r.url}`)
const excludedHits = requests.filter((r) => excluded.some((n) => r.url.includes(n))).map((r) => r.url)
const studioReqs = requests.filter((r) => r.url.startsWith(studioOrigin))
report.checks.requests = {
  total: requests.length,
  studio: studioReqs.length,
  external, httpErrors: bad, failed, excludedFonts: excludedHits,
}
if (external.length) fail(`외부 요청 ${external.length}건: ${external.slice(0, 5).join(', ')}`)
if (bad.length) fail(`4xx/5xx 응답 ${bad.length}건: ${bad.slice(0, 5).join(', ')}`)
if (failed.length) fail(`실패한 요청 ${failed.length}건: ${failed.slice(0, 5).join(', ')}`)
if (excludedHits.length) fail(`제외한 글꼴 요청 ${excludedHits.length}건`)
report.transfer = {
  note: 'studio origin 응답 본문 바이트 합계. 서버는 brotli quality 5 로 압축 (woff2 는 그대로)',
  studioBodyBytes: studioReqs.reduce((a, r) => a + (r.bodyBytes || 0), 0),
  files: studioReqs.map((r) => ({ path: r.url.slice(studioOrigin.length), bytes: r.bodyBytes, encoding: r.encoding })),
}
report.consoleErrors = consoleErrors
if (consoleErrors.some((m) => /Content Security Policy|Refused to/.test(m))) fail('CSP 위반 콘솔 오류가 있습니다')
await finish()
