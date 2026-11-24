#!/usr/bin/env node
/**
 * 이 포크(Kangchanghwan/rhwp)의 소스에서 편집기 사이트를 조립한다. 결과는 cs/out/ (사이트 루트 기준).
 *
 * hwp-editor 의 scripts/build.mjs 를 옮긴 것이다. 달라진 점: upstream 을 새로 받지 않고
 * 이 체크아웃의 rhwp-studio 를 쓰며, 엔진 wasm 은 npm 이 아니라 이 레포의 Rust 소스에서 빌드한 pkg/ 를 쓴다
 * (pkg/ 는 워크플로가 만든다: scripts/measure_render_diff_wasm.py --profile release --build-mode standard).
 *
 * 단계
 *  1. pkg/ 확인, 엔진 wasm sha256 을 npm @rhwp/core 와 비교해 기록
 *  2. 엔진 wasm 을 조각으로 나누고(Cloudflare Pages 파일당 25 MiB 제한) wasm-bindgen glue 를 이어 붙이는 로더로 패치
 *  3. studio 글꼴 규칙에서 제외 글꼴을 Pretendard 로 바꿈
 *  4. vite build --base=/, samples 와 PWA service worker 제거
 *  5. cs/out/ 조립: 제외 글꼴·라이선스 PDF 삭제, 라이선스, agent, manifest.json, build-identity.json, _headers
 *
 * 이 스크립트는 체크아웃을 직접 고친다(CI 전용). pkg/ 캐시는 이 스크립트 실행 전에 저장해야 한다.
 * 사용: node cs/build/build.mjs
 */
import { execFileSync } from 'node:child_process'
import { brotliCompressSync, constants as zc } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLimits } from './check-limits.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cs = join(here, '..')
const repo = join(cs, '..')
const root = cs // agent/, NOTICE, .cache, out 은 cs/ 아래
const cfg = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'))
const fork = JSON.parse(readFileSync(join(cs, 'upstream.json'), 'utf8'))
const up = { ...cfg, tag: fork.tag, repo: fork.repo, commit: fork.commit, coreVersion: cfg.npmCore.version, coreIntegrity: cfg.npmCore.integrity }
const cacheRoot = join(cs, '.cache')
const cachedDist = join(cacheRoot, 'studio-dist')
const cachedMeta = join(cacheRoot, 'meta.json')
const outDir = join(cs, 'out')
const t0 = Date.now()

const log = (msg) => console.log(`[cs-build] ${msg}`)
const fail = (msg) => {
  console.error(`\n[cs-build] 실패: ${msg}\n`)
  process.exit(1)
}
const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { stdio: 'inherit', ...opts })
  } catch (e) {
    fail(`'${cmd} ${args.join(' ')}' 실행 오류 (${e.message})`)
  }
}
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const major = Number(process.versions.node.split('.')[0])
if (major < 20) fail(`Node ${process.versions.node} 는 지원하지 않습니다 (20 이상 필요)`)

/* ------------------------------------------------------------------ studio build */

async function buildStudio() {
  const tb = Date.now()
  const head = process.env.GITHUB_SHA || git('rev-parse', 'HEAD')
  log(`포크 ${head.slice(0, 8)} (upstream ${up.tag}) 에서 studio 빌드 시작`)
  rmSync(cacheRoot, { recursive: true, force: true })
  mkdirSync(cacheRoot, { recursive: true })
  const work = repo

  // 1. engine built from this repo's source
  const pkg = join(work, 'pkg')
  const wasmPath = join(pkg, 'rhwp_bg.wasm')
  const gluePath = join(pkg, 'rhwp.js')
  if (!existsSync(wasmPath) || !existsSync(gluePath)) fail('pkg/rhwp_bg.wasm 또는 pkg/rhwp.js 가 없습니다 (Rust 빌드 결과 필요)')
  const wasm = readFileSync(wasmPath)
  const wasmSha = sha256(wasm)
  const sameAsNpm = wasmSha === cfg.npmCore.wasmSha256
  log(`엔진 wasm ${wasm.length} bytes, sha256 ${wasmSha}`)
  log(`npm @rhwp/core ${cfg.npmCore.version} 과 ${sameAsNpm ? '같음' : '다름'} (npm ${cfg.npmCore.wasmSha256})`)
  // wasm-pack-locked.sh 가 public/ 에 복사해 둔 사본은 사이트에 실리면 안 된다 (조각으로만 싣는다)
  rmSync(join(work, 'rhwp-studio', 'public', 'rhwp_bg.wasm'), { force: true })
  try { execFileSync('git', ['checkout', '--', 'rhwp-studio/public/rhwp.js'], { cwd: repo, stdio: 'inherit' }) } catch { log('경고: public/rhwp.js 를 원래대로 되돌리지 못했습니다') }
  // npm 패키지(@rhwp/core)와 같은 보완: package.json, README, notices/ (upstream scripts/prepare-npm.sh)
  if (!existsSync(join(pkg, 'notices'))) run('bash', ['scripts/prepare-npm.sh'], { cwd: repo })
  // engine license and third-party notices for out/licenses/
  mkdirSync(join(cacheRoot, 'core-notices'), { recursive: true })
  if (existsSync(join(pkg, 'notices'))) cpSync(join(pkg, 'notices'), join(cacheRoot, 'core-notices', 'notices'), { recursive: true })
  else log('경고: pkg/notices 가 없습니다')
  cpSync(existsSync(join(pkg, 'LICENSE')) ? join(pkg, 'LICENSE') : join(work, 'LICENSE'), join(cacheRoot, 'core-notices', 'LICENSE'))
  cpSync(join(work, 'LICENSE'), join(cacheRoot, 'rhwp-LICENSE'))

  // 2. split wasm and patch the glue
  const n = up.wasmParts
  const partSize = Math.ceil(wasm.length / n)
  const partNames = []
  for (let i = 0; i < n; i++) {
    const name = `rhwp_bg.part${i}.wasm`
    writeFileSync(join(pkg, name), wasm.subarray(i * partSize, Math.min(wasm.length, (i + 1) * partSize)))
    partNames.push(name)
  }
  rmSync(wasmPath) // nothing may reference the unsplit file any more
  let glue = readFileSync(gluePath, 'utf8')
  const needle = "module_or_path = new URL('rhwp_bg.wasm', import.meta.url);"
  if (glue.split(needle).length !== 2) fail('rhwp.js 에서 wasm 기본 경로를 찾지 못했습니다 (wasm-bindgen 출력이 바뀜)')
  glue = glue.replace(needle,
    `module_or_path = __hwpEditorWasmParts([${partNames.map((p) => `new URL('${p}', import.meta.url)`).join(', ')}]);`)
  glue += `
// hwp-editor: the engine wasm is split into parts because Cloudflare Pages serves at most
// 25 MiB per file. Fetch all parts in parallel and stream them back as one wasm response.
async function __hwpEditorWasmParts(urls) {
    const responses = await Promise.all(urls.map((u) => fetch(u)));
    for (const r of responses) {
        if (!r.ok || !r.body) throw new Error(\`failed to fetch Wasm part: \${r.status} \${r.url}\`);
    }
    let index = 0;
    let reader = null;
    const body = new ReadableStream({
        async pull(controller) {
            for (;;) {
                if (!reader) {
                    if (index >= responses.length) { controller.close(); return; }
                    reader = responses[index++].body.getReader();
                }
                const { done, value } = await reader.read();
                if (done) { reader = null; continue; }
                controller.enqueue(value);
                return;
            }
        },
    });
    return new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
}
`
  writeFileSync(gluePath, glue)

  // 3. font exclusion: point the studio font rules at shipped fonts
  const replaced = Object.fromEntries(Object.keys(up.excludedFonts).map((k) => [k, 0]))
  const srcDirs = ['rhwp-studio/src', 'rhwp-shared', 'npm/hwpctrl-ocx/src', 'npm/editor']
    .map((d) => join(work, d)).filter((d) => existsSync(d))
  for (const dir of srcDirs) {
    for (const file of walk(dir)) {
      if (file.includes('node_modules') || !/\.(ts|js|mjs|json)$/.test(file)) continue
      let text = readFileSync(file, 'utf8')
      let changed = false
      for (const [from, to] of Object.entries(up.excludedFonts)) {
        const parts = text.split(`fonts/${from}`)
        if (parts.length > 1) {
          replaced[from] += parts.length - 1
          text = parts.join(`fonts/${to}`)
          changed = true
        }
      }
      if (changed) writeFileSync(file, text)
    }
  }
  for (const [from, count] of Object.entries(replaced)) {
    if (count === 0) fail(`글꼴 규칙에서 fonts/${from} 를 찾지 못했습니다 (upstream 글꼴 규칙이 바뀜, 매핑을 다시 확인)`)
  }
  log(`글꼴 매핑 교체: ${JSON.stringify(replaced)}`)

  // 4. vite build at site root
  const studio = join(work, 'rhwp-studio')
  run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: studio })
  run('npx', ['vite', 'build', `--base=${up.base}`], {
    cwd: studio,
    env: { ...process.env, RHWP_DISABLE_EXTERNAL_WEBFONTS: '1', RHWP_WITHOUT_AI: '1' },
  })

  const built = join(studio, 'dist')
  rmSync(join(built, 'samples'), { recursive: true, force: true })
  // PWA: same post-processing as the Clipboard Share build (no service worker, no web manifest)
  for (const f of readdirSync(built)) {
    if (f === 'sw.js' || f === 'registerSW.js' || f === 'manifest.webmanifest' || /^workbox-.*\.js$/.test(f)) {
      rmSync(join(built, f), { force: true })
    }
  }
  const idx = join(built, 'index.html')
  let html = readFileSync(idx, 'utf8')
  html = html
    .replace(/<script[^>]*registerSW\.js[^>]*><\/script>\s*/g, '')
    .replace(/<link[^>]*rel="manifest"[^>]*>\s*/g, '')
  if (/registerSW|manifest\.webmanifest|serviceWorker/.test(html)) fail('index.html 에서 PWA 참조를 제거하지 못했습니다')
  writeFileSync(idx, html)
  for (const f of walk(built)) {
    if (/\.js$/.test(f) && /navigator\.serviceWorker\.register|workbox/.test(readFileSync(f, 'utf8'))) {
      fail(`빌드 결과에 service worker 등록 코드가 남아 있습니다: ${relative(built, f)}`)
    }
  }

  // the wasm parts must concatenate back to the verified engine
  const assets = readdirSync(join(built, 'assets'))
  const builtParts = partNames.map((p) => {
    const re = new RegExp(`^${p.replace('.wasm', '').replace('.', '\\.')}-[\\w-]+\\.wasm$`)
    const hit = assets.find((a) => re.test(a))
    if (!hit) fail(`빌드 결과에서 ${p} 를 찾지 못했습니다`)
    return hit
  })
  const joined = Buffer.concat(builtParts.map((a) => readFileSync(join(built, 'assets', a))))
  if (sha256(joined) !== sha256(wasm)) fail('wasm 조각을 이어 붙인 결과가 원본과 다릅니다')
  if (assets.some((a) => /^rhwp_bg-[\w-]+\.wasm$/.test(a))) fail('나누지 않은 wasm 이 빌드 결과에 남아 있습니다')

  cpSync(built, cachedDist, { recursive: true, dereference: true })
  writeFileSync(cachedMeta, JSON.stringify({
    forkCommit: head,
    wasmSha256: wasmSha,
    wasmBytes: wasm.length,
    wasmSameAsNpm: sameAsNpm,
    wasmParts: builtParts.map((p) => `assets/${p}`),
    fontRuleReplacements: replaced,
    studioBuildSeconds: Math.round((Date.now() - tb) / 1000),
  }, null, 2))
}

await buildStudio()
const meta = JSON.parse(readFileSync(cachedMeta, 'utf8'))

/* ------------------------------------------------------------------ assemble out/ */

rmSync(outDir, { recursive: true, force: true })
cpSync(cachedDist, outDir, { recursive: true, dereference: true })

// upstream and engine licenses (copied first so the exclusion below also covers them)
mkdirSync(join(outDir, 'licenses'), { recursive: true })
cpSync(join(cacheRoot, 'rhwp-LICENSE'), join(outDir, 'licenses', 'rhwp-LICENSE.txt'))
cpSync(join(cacheRoot, 'core-notices'), join(outDir, 'licenses', 'rhwp-core'), { recursive: true })
cpSync(join(root, 'NOTICE'), join(outDir, 'licenses', 'NOTICE.txt'))

// excluded fonts and their license PDFs are not shipped, wherever they appear
const fontsDir = join(outDir, 'fonts')
const dropNames = new Set([...Object.keys(up.excludedFonts), ...up.excludedLicenseFiles])
let dropped = 0
for (const f of walk(outDir)) {
  const base = f.split('/').pop()
  if (dropNames.has(base)) { rmSync(f); dropped++ }
}
log(`제외 파일 ${dropped}개 삭제`)
for (const to of new Set(Object.values(up.excludedFonts))) {
  if (!existsSync(join(fontsDir, to))) fail(`대체 글꼴 fonts/${to} 가 빌드 결과에 없습니다`)
}
// font-notices.json lists shipped fonts; keep every copy in sync with what we ship
for (const noticesPath of walk(outDir).filter((f) => f.endsWith('/font-notices.json'))) {
  const notices = JSON.parse(readFileSync(noticesPath, 'utf8'))
  const before = notices.fonts.length
  notices.fonts = notices.fonts.filter((f) => !(f.file in up.excludedFonts))
  notices.hwpEditorExcluded = Object.keys(up.excludedFonts)
  writeFileSync(noticesPath, JSON.stringify(notices, null, 2) + '\n')
  log(`${relative(outDir, noticesPath)}: ${before} -> ${notices.fonts.length} 항목`)
}
writeFileSync(join(fontsDir, 'licenses', 'EXCLUDED.txt'), [
  '이 배포(hwp-editor)에서 뺀 글꼴',
  '',
  '아래 글꼴은 upstream rhwp 에 들어 있지만 라이선스가 PDF 로만 제공되어 재배포 조건을 아직 확인하지 못했다.',
  '확인될 때까지 파일을 싣지 않고, 편집기의 글꼴 규칙은 같은 이름을 오른쪽 글꼴로 대신 그리게 바꿨다.',
  '',
  ...Object.entries(up.excludedFonts).map(([f, to]) => `${f} -> ${to}`),
  '',
].join('\n'))

// nothing in the shipped code may still point at an excluded font file
const excludedNames = Object.keys(up.excludedFonts)
for (const f of walk(outDir)) {
  const rel = relative(outDir, f)
  if (dropNames.has(rel.split('/').pop())) fail(`제외한 파일이 남아 있습니다: ${rel}`)
  if (rel.startsWith('fonts/licenses/') || rel.startsWith('licenses/') || rel === 'fonts/FONTS.md') continue
  if (!/\.(js|mjs|css|html|json|txt|webmanifest)$/.test(f)) continue
  const text = readFileSync(f, 'utf8')
  for (const name of excludedNames) {
    if (text.includes(name)) fail(`${rel} 에 제외한 글꼴 ${name} 참조가 남아 있습니다`)
  }
}

// agent: Clipboard Share 의 AI 편집 함수(agent/*.js)를 studio 페이지에 함께 싣는다. 같은 출처라 facade 등을 직접 쓰고,
// 부모와는 agent/bridge.js 의 postMessage 창구로만 대화한다. 내용 해시 폴더라 /assets/* 의 immutable 캐시를 그대로 쓴다.
const AGENT_FILES = ['entry.js', 'bridge.js', 'editBridge.js', 'editHost.js', 'hwpAgent.js', 'hwpAgentMethods.js']
const agentSrc = join(root, 'agent')
const agentHash = createHash('sha256')
for (const f of AGENT_FILES) agentHash.update(f).update(readFileSync(join(agentSrc, f)))
const agentDirName = `cb-agent-${agentHash.digest('hex').slice(0, 10)}`
mkdirSync(join(outDir, 'assets', agentDirName), { recursive: true })
for (const f of AGENT_FILES) cpSync(join(agentSrc, f), join(outDir, 'assets', agentDirName, f))
{
  const idxOut = join(outDir, 'index.html')
  const page = readFileSync(idxOut, 'utf8')
  if (!page.includes('</head>')) fail('index.html 에 </head> 가 없습니다')
  writeFileSync(idxOut, page.replace('</head>', `  <script type="module" src="${up.base}assets/${agentDirName}/entry.js"></script>\n</head>`))
}
log(`에이전트 창구: assets/${agentDirName}/ (${AGENT_FILES.length}개 파일)`)

// manifest.json: files the studio always fetches at start, for the host's progress bar.
// url is relative to this site's root; est is the brotli transfer estimate.
const assets = readdirSync(join(outDir, 'assets'))
const find = (re) => assets.find((f) => re.test(f))
const mainJs = find(/^index-.*\.js$/)
const mainCss = find(/^index-.*\.css$/)
const plugin = find(/^studio-plugin-.*\.js$/)
if (!mainJs) fail('manifest: 시작 파일을 찾지 못했습니다 (studio 번들 구조가 바뀜)')
const rels = [...meta.wasmParts, `assets/${mainJs}`, mainCss && `assets/${mainCss}`, plugin && `assets/${plugin}`,
  'fonts/RHWPOldHangul-Regular.woff2', 'fonts/Pretendard-Regular.woff2', 'fonts/NotoSansKR-Regular.woff2',
  'fonts/NotoSansKR-Bold.woff2'].filter(Boolean)
const manifestFiles = rels.filter((r) => existsSync(join(outDir, r))).map((rel) => {
  const buf = readFileSync(join(outDir, rel))
  const est = /\.woff2$/.test(rel) ? buf.length : brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }).length
  return { url: up.base + rel, raw: buf.length, est }
})
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ v: 1, tag: up.tag, base: up.base, files: manifestFiles }))

// 404.html: without it Cloudflare Pages answers unknown paths with index.html and status 200,
// which would hide requests for files that are not shipped
writeFileSync(join(outDir, '404.html'), '<!doctype html><meta charset="utf-8"><title>404</title><p>없는 파일입니다.</p>\n')

// build-identity.json
function ourCommit() {
  if (process.env.CS_BUILD) return process.env.CS_BUILD
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'local'
  }
}
const forkCommit = ourCommit()
const forkRepo = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : 'https://github.com/Kangchanghwan/rhwp'
writeFileSync(join(outDir, 'build-identity.json'), JSON.stringify({
  source: 'fork',
  fork: { repo: forkRepo, commit: forkCommit, ref: process.env.GITHUB_REF_NAME || null },
  upstream: { repo: up.repo, tag: up.tag, commit: up.commit },
  core: {
    version: up.coreVersion,
    builtFrom: 'fork-source',
    wasmSha256: meta.wasmSha256,
    wasmBytes: meta.wasmBytes,
    wasmSameAsNpm: meta.wasmSameAsNpm,
    npmWasmSha256: cfg.npmCore.wasmSha256,
    wasmParts: meta.wasmParts,
  },
  csBuild: forkCommit,
  agent: `assets/${agentDirName}/entry.js`,
  excludedFonts: up.excludedFonts,
  builtAt: new Date().toISOString(),
}, null, 2) + '\n')

// _headers (Cloudflare Pages). Each header name is set by one rule only, because Pages
// joins values with a comma when several matching rules set the same header.
// CORS and Timing-Allow-Origin on static files let clipboardapp.org preload them with a
// progress bar and tell cache hits (transferSize 0) from downloads.
const frameAncestors = 'frame-ancestors https://clipboardapp.org https://www.clipboardapp.org https://*.vercel.app http://localhost:* http://127.0.0.1:*'
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  frameAncestors,
].join('; ')
const noCacheBlock = (p) => `${p}\n  Cache-Control: no-cache\n`
writeFileSync(join(outDir, '_headers'), [
  '/*',
  `  Content-Security-Policy: ${csp}`,
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '',
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '  Access-Control-Allow-Origin: *',
  '  Timing-Allow-Origin: *',
  '',
  '/fonts/*',
  '  Cache-Control: public, max-age=2592000',
  '  Access-Control-Allow-Origin: *',
  '  Timing-Allow-Origin: *',
  '',
  noCacheBlock('/'),
  noCacheBlock('/index.html'),
  '/manifest.json',
  '  Cache-Control: no-cache',
  '  Access-Control-Allow-Origin: *',
  '',
  '/build-identity.json',
  '  Cache-Control: no-cache',
  '  Access-Control-Allow-Origin: *',
  '',
].join('\n'))

/* ------------------------------------------------------------------ report */

const lim = checkLimits(outDir)
const firstOpen = manifestFiles.reduce((a, f) => a + f.est, 0)
const report = {
  files: lim.count,
  totalBytes: lim.total,
  largest: lim.largest,
  manifestRawBytes: manifestFiles.reduce((a, f) => a + f.raw, 0),
  manifestBrotliBytes: firstOpen,
  studioBuildSeconds: meta.studioBuildSeconds,
  totalSeconds: Math.round((Date.now() - t0) / 1000),
}
writeFileSync(join(cacheRoot, 'build-report.json'), JSON.stringify(report, null, 2))
log(`out/ ${lim.count}개 파일, ${(lim.total / 1048576).toFixed(1)} MiB, 가장 큰 파일 ${lim.largest.path} ${(lim.largest.bytes / 1048576).toFixed(2)} MiB`)
log(`시작 파일 전송 추정(brotli) ${(firstOpen / 1048576).toFixed(1)} MiB, 걸린 시간 ${report.totalSeconds}초`)
if (!lim.ok) fail(lim.errors.join('\n'))
