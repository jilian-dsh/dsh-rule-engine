// FULL mount-consistency audit: bundles vs user patch inserts vs bundle-internal patches vs dependencies
// Goal: detect ANY loader entry id that would be mounted more than once (duplicate loader entry crash)
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || 'D:/DeepSeek harness/.dsh'
const DEFAULT_PROFILE = 'web'
function profileNameFromArgs() {
  const argv = process.argv
  let idx = argv.indexOf('--profile')
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1]
  const eq = argv.find((a) => a.startsWith('--profile='))
  if (eq) return eq.slice('--profile='.length)
  return DEFAULT_PROFILE
}
const PROFILE_NAME = profileNameFromArgs()
const PROFILE = join(DSH_HOME, 'profiles', PROFILE_NAME)
console.log(`Profile: ${PROFILE_NAME} -> ${PROFILE}`)
if (!existsSync(join(PROFILE, 'package.json'))) {
  console.error(`[ERROR] profile package.json not found: ${join(PROFILE, 'package.json')}`)
  process.exit(2)
}
const profilePkg = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
const requireFromProfile = createRequire(join(PROFILE, 'package.json'))

/** 从 patch 文本提取 insert 块中的 loader entry id（支持块状和行内两种写法） */
function extractInsertIds(text) {
  const ids = []
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/^-\s*insert:/i.test(line)) continue
    const rest = line.replace(/^-\s*insert:\s*/i, '')
    if (rest.trim()) {
      // 行内形式：- insert: { id: xxx } / - insert: - id: xxx
      for (const m of rest.matchAll(/id:\s*["']?([^\s#"']+)/gi)) ids.push(m[1])
      continue
    }
    // 块状形式：- insert: 后跟缩进的 - id: xxx
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (/^\S/.test(l) && !/^\s/.test(l)) break // 回到顶层条目
      const m = l.match(/^\s+- id:\s*["']?([^\s#"']+)/i)
      if (m) ids.push(m[1])
    }
  }
  return [...new Set(ids)]
}

/** 解析 bundle 包路径：优先 profile/node_modules，再 profiles/node_modules，最后用 Node 解析 */
function resolveBundlePkg(b) {
  const candidates = [
    join(PROFILE, 'node_modules', b, 'package.json'),
    join(DSH_HOME, 'profiles', 'node_modules', b, 'package.json')
  ]
  if (b.startsWith('@')) {
    const [scope, name] = b.split('/')
    candidates.push(join(DSH_HOME, 'profiles', 'node_modules', scope, name, 'package.json'))
  }
  for (const c of candidates) if (existsSync(c)) return c
  try {
    return requireFromProfile.resolve(`${b}/package.json`)
  } catch {
    return null
  }
}

/** 读取一个 patch 文件并把其中的 insert id 记入 sources */
function collectPatchInserts(patchPath, viaLabel) {
  if (!existsSync(patchPath)) return []
  const ids = extractInsertIds(readFileSync(patchPath, 'utf8'))
  for (const id of ids) sources.push({ id, via: viaLabel, file: patchPath })
  return ids
}

// ---- collect all sources of loader entry ids ----
const sources = [] // {id, via, file}

// 1. profile bundles array (each bundle's internal cordis.patch.yml inserts + the bundle row itself)
const bundles = profilePkg.dsh?.profile?.bundles || []
console.log('=== 1. profile bundles array (' + bundles.length + ') ===')
for (const b of bundles) {
  console.log('  bundle:', b)
  const pkgPath = resolveBundlePkg(b)
  if (!pkgPath) { console.log('    [WARN] package.json not found for ' + b); continue }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const patchRel = pkg.dsh?.bundle?.patch
  if (patchRel) {
    const patchPath = join(dirname(pkgPath), patchRel)
    const inserts = collectPatchInserts(patchPath, `bundle-internal patch of ${b}`)
    if (existsSync(patchPath)) {
      console.log(`    internal patch ${patchRel}: inserts = ${inserts.length ? inserts.join(',') : '(none)'}`)
    } else {
      console.log('    [WARN] bundle patch missing: ' + patchPath)
    }
  }
  // the bundle package itself may be a plugin row too (via loader) — record its name as entry candidate
  // (bundle packages themselves are not loader entries; only their patch rows are)
}

// 2. user cordis.patch.yml inserts (profile layer)
const userPatchPath = join(PROFILE, 'cordis.patch.yml')
const userPatch = readFileSync(userPatchPath, 'utf8')
console.log('\n=== 2. user cordis.patch.yml (profile layer) ===')
const userInserts = collectPatchInserts(userPatchPath, 'user patch insert')
// also non-insert top-level entries (override/disable by id) — these do NOT create entries but list them
const topLevelIds = [...userPatch.matchAll(/^-\s+id:\s+([^\s#]+)/gm)].map((m) => m[1])
console.log('  user patch top-level ids:', topLevelIds.join(',') || '(none)')
console.log('  user patch inserts:', userInserts.join(',') || '(none)')

// 2.5 root user cordis.patch.yml inserts (if present)
const rootPatchPath = join(DSH_HOME, 'cordis.patch.yml')
const rootInserts = []
if (existsSync(rootPatchPath)) {
  console.log('\n=== 2.5 root user cordis.patch.yml ===')
  rootInserts.push(...collectPatchInserts(rootPatchPath, 'root user patch insert'))
  console.log('  root user patch inserts:', rootInserts.join(',') || '(none)')
} else {
  console.log('\n=== 2.5 root user cordis.patch.yml ===')
  console.log('  (no root cordis.patch.yml)')
}

// 3. dependencies with link/github/http (local dev packages) — check their type
console.log('\n=== 3. dependencies type check ===')
const deps = profilePkg.dependencies || {}
for (const [name, spec] of Object.entries(deps)) {
  const isLocal = typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('github:') || spec.startsWith('http') || spec.startsWith('file:'))
  console.log(`  ${name}: ${spec} ${isLocal ? '(LOCAL/dev)' : ''}`)
  if (isLocal) {
    // resolve local dir and check dsh type
    let dir = null
    if (spec.startsWith('link:')) dir = spec.slice(5)
    else if (spec.startsWith('file:')) dir = spec.slice(5)
    else if (spec.startsWith('github:') || spec.startsWith('http')) dir = join(PROFILE, 'node_modules', name)
    if (dir) {
      const lp = join(dir.replace(/\\/g, '/'), 'package.json')
      if (existsSync(lp)) {
        const lpj = JSON.parse(readFileSync(lp, 'utf8'))
        const dshType = lpj.dsh?.bundle ? 'dsh.bundle' : (lpj.dsh?.plugin ? 'dsh.plugin' : (lpj.dsh ? JSON.stringify(lpj.dsh) : 'no dsh field'))
        const inBundles = bundles.includes(name)
        const inUserPatch = userInserts.includes(name) || rootInserts.includes(name) || topLevelIds.includes(name)
        console.log(`    -> type: ${dshType} | inBundles: ${inBundles} | inUserPatch: ${inUserPatch}`)
        // rule 24: dsh.plugin must NOT be in bundles; dsh.bundle SHOULD be in bundles not in user patch insert
        if (dshType === 'dsh.plugin' && inBundles) {
          console.log('    [VIOLATION rule24] dsh.plugin in bundles!')
        }
        if (dshType === 'dsh.bundle' && inUserPatch) {
          console.log('    [WARN] dsh.bundle also present in user patch — check duplicate')
        }
      }
    }
  }
}

// 3.5 runtime injection registry (super-injector) — also produces loader entries
console.log('\n=== 3.5 runtime injection registry ===')
const superInjectorRegistry = join(DSH_HOME, 'super-injector', 'registry.json')
try {
  if (existsSync(superInjectorRegistry)) {
    const reg = JSON.parse(readFileSync(superInjectorRegistry, 'utf8'))
    if (!Array.isArray(reg)) throw new Error('registry.json is not an array')
    const names = reg.map((e) => e && e.name).filter(Boolean)
    for (const name of names) {
      sources.push({ id: name, via: 'runtime injection (super-injector registry)', file: superInjectorRegistry })
    }
    console.log('  runtime injected:', names.join(', ') || '(none)')
  } else {
    console.log('  (no super-injector registry found; if dev_inject_plugin has been used, run dev_injected_list to confirm)')
  }
} catch (e) {
  console.log('  [WARN] failed to read super-injector registry:', e instanceof Error ? e.message : String(e))
}

// 4. duplicate detection across ALL sources
console.log('\n=== 4. DUPLICATE LOADER ENTRY DETECTION ===')
const byId = new Map()
for (const s of sources) {
  if (!byId.has(s.id)) byId.set(s.id, [])
  byId.get(s.id).push(s)
}
let dupFound = false
for (const [id, list] of byId) {
  if (list.length > 1) {
    dupFound = true
    console.log(`  [DUPLICATE] id "${id}" mounted ${list.length} times:`)
    for (const s of list) console.log(`    - via ${s.via} (${s.file})`)
  }
}
if (!dupFound) console.log('  NO duplicate loader entry ids found — clean')

// 5. also check bundle rows vs their internal patch first insert (self-reference is fine)
console.log('\n=== 5. summary ===')
console.log('  bundles:', bundles.join(', '))
console.log('  user inserts:', userInserts.join(',') || '(none)')
console.log('  root user inserts:', rootInserts.join(',') || '(none)')
console.log(dupFound ? '  RESULT: DUPLICATES FOUND — MUST FIX BEFORE RESTART' : '  RESULT: MOUNT CONSISTENT — SAFE TO RESTART')
process.exit(dupFound ? 1 : 0)
