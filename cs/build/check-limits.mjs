#!/usr/bin/env node
/**
 * Cloudflare Pages limits: fewer than 20,000 files per deployment and at most 25 MiB per file.
 * Usage: node scripts/check-limits.mjs [dir]   (default: out)
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_FILES = 20000
export const MAX_FILE_BYTES = 25 * 1024 * 1024

export function checkLimits(dir) {
  let count = 0
  let total = 0
  let largest = { path: '', bytes: 0 }
  const errors = []
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) { walk(p); continue }
      const size = statSync(p).size
      count++
      total += size
      if (size > largest.bytes) largest = { path: relative(dir, p), bytes: size }
      if (size > MAX_FILE_BYTES) errors.push(`${relative(dir, p)} 가 ${size} bytes 로 25 MiB 를 넘습니다`)
    }
  }
  walk(dir)
  if (count >= MAX_FILES) errors.push(`파일이 ${count}개로 ${MAX_FILES}개 제한 이상입니다`)
  return { ok: errors.length === 0, count, total, largest, errors }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] || 'out')
  const r = checkLimits(dir)
  console.log(`[check-limits] ${r.count}개 파일, 합계 ${r.total} bytes, 가장 큰 파일 ${r.largest.path} (${r.largest.bytes} bytes)`)
  if (!r.ok) {
    for (const e of r.errors) console.error(`[check-limits] ${e}`)
    process.exit(1)
  }
}
