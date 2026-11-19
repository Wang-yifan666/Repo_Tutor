#!/usr/bin/env node
// 发布自检：把「要发出去的东西」按发布顺序查一遍，但不发。
//
// 它做七件事：
//   1. 版本一致性：主包 == 每个平台包 == optionalDependencies 里的精确版本
//   2. 依赖表 == 可发布平台集合：publish=false 的平台不许出现在 optionalDependencies
//   3. dist-tag：预发布版本必须是 next，正式版本必须是 latest（publishConfig 也要对得上）
//   4. 隔离打包：每个包各自一个输出目录，并发跑也不会互相覆盖
//   5. tarball 清单：必须有的一律有，仓库里的东西和敏感文件一律没有
//   6. 完整性：平台包里的二进制 SHA-256 与 tarball 的 SHA-256 都记下来
//   7. npm publish --dry-run：走完 npm 自己的校验，不联网发布
//
// 用法：
//   node scripts/release-check.mjs                # 全套
//   node scripts/release-check.mjs --no-dry-run   # 跳过 npm publish --dry-run
// 退出码：0 通过，1 有断言失败，2 用法错误。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = join(packageRoot, 'dist')

const argv = process.argv.slice(2)
const known = new Set(['--no-dry-run'])
for (const arg of argv) {
  if (!known.has(arg)) {
    console.error(`usage: release-check.mjs [--no-dry-run]  (unknown argument ${arg})`)
    process.exit(2)
  }
}
const runDryRun = !argv.includes('--no-dry-run')

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const config = JSON.parse(readFileSync(join(packageRoot, 'platforms.config.json'), 'utf8'))
const version = manifest.version
const scope = config.scope
const publishable = config.targets.filter((target) => target.publish !== false)
const held = config.targets.filter((target) => target.publish === false)

let failures = 0
function check(condition, message, detail) {
  if (condition) {
    console.log(`ok    ${message}`)
  } else {
    failures += 1
    console.log(`FAIL  ${message}${detail === undefined ? '' : `\n      ${detail}`}`)
  }
}

const isWindows = process.platform === 'win32'
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 180000, ...options })
}
function npm(args, options = {}) {
  const command = isWindows ? 'npm.cmd' : 'npm'
  const safe = isWindows ? args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)) : args
  return run(command, safe, { shell: isWindows, ...options })
}
const suffixOf = (target) => `${target.platform}-${target.arch}`
const nameOf = (target) => `${scope}/core-${suffixOf(target)}`
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

// ── 1 & 2. 版本与依赖表 ───────────────────────────────────────────────────

console.log(`# release check for ${manifest.name}@${version}\n`)

check(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
  `version is a valid semver (${version})`,
)

const optional = manifest.optionalDependencies ?? {}
const expectedNames = publishable.map(nameOf)
const declaredNames = Object.keys(optional)

check(
  declaredNames.length === expectedNames.length &&
    expectedNames.every((name) => declaredNames.includes(name)),
  'optionalDependencies covers exactly the publishable platforms',
  `declared: ${declaredNames.join(', ') || '(none)'} / publishable: ${expectedNames.join(', ')}`,
)
for (const name of declaredNames) {
  check(
    optional[name] === version,
    `${name} is pinned to the exact main version`,
    `declares ${optional[name]}, main package says ${version}`,
  )
  check(
    !/^[\^~<>]|\s/.test(optional[name]),
    `${name} pin is not a range`,
    `declares ${optional[name]}`,
  )
}
for (const target of held) {
  check(
    !declaredNames.includes(nameOf(target)),
    `${suffixOf(target)} is publish=false and stays out of optionalDependencies`,
    `optionalDependencies still lists ${nameOf(target)}`,
  )
}
check(
  manifest.repoTutor?.protocolVersion === config.protocolVersion,
  `protocol version agrees between package.json and platforms.config.json (${config.protocolVersion})`,
)

// ── 3. dist-tag ───────────────────────────────────────────────────────────

const expectedTag = version.includes('-') ? 'next' : 'latest'
const manifestTag = manifest.publishConfig?.tag
if (manifestTag === undefined) {
  console.log(`warn  no publishConfig.tag: a bare npm publish would tag this as "latest"`)
} else {
  check(
    manifestTag === expectedTag,
    `publishConfig.tag is "${expectedTag}" for ${version}`,
    `publishConfig.tag is "${manifestTag}" — a prerelease published without --tag lands on latest`,
  )
}

// ── 4. 每个平台包 ─────────────────────────────────────────────────────────

const platformDirs = new Map()
for (const target of publishable) {
  const suffix = suffixOf(target)
  const dir = join(distRoot, 'platforms', suffix)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    check(false, `${suffix} platform package exists`, `missing ${manifestPath} — run: node scripts/make-platform-packages.mjs --platform ${suffix} --core <binary>`)
    continue
  }
  platformDirs.set(target, dir)
  const platformManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check(platformManifest.name === nameOf(target), `${suffix} package name is ${nameOf(target)}`, platformManifest.name)
  check(platformManifest.version === version, `${suffix} package version matches the main package`, `${platformManifest.version} !== ${version}`)
  check(
    platformManifest.repoTutor?.protocolVersion === config.protocolVersion,
    `${suffix} declares protocol ${config.protocolVersion}`,
    String(platformManifest.repoTutor?.protocolVersion),
  )
  check(
    JSON.stringify(platformManifest.os) === JSON.stringify([target.platform]) &&
      JSON.stringify(platformManifest.cpu) === JSON.stringify([target.arch]),
    `${suffix} is gated on os/cpu so npm refuses to install it elsewhere`,
  )
  check(
    platformManifest.publishConfig?.access === 'public',
    `${suffix} is published public (scoped packages default to private)`,
    String(platformManifest.publishConfig?.access),
  )
  check(
    platformManifest.publishConfig?.tag === expectedTag,
    `${suffix} publishConfig.tag is "${expectedTag}"`,
    String(platformManifest.publishConfig?.tag),
  )

  const binary = join(dir, platformManifest.repoTutor?.core ?? '')
  if (existsSync(binary)) {
    const digest = sha256(binary)
    const recorded = existsSync(join(dir, 'checksums.txt'))
      ? readFileSync(join(dir, 'checksums.txt'), 'utf8').trim().split(/\s+/)[0]
      : ''
    check(digest === recorded, `${suffix} checksums.txt matches the binary on disk`, `${digest} !== ${recorded}`)
    check(statSync(binary).size > 100_000, `${suffix} binary looks like a real executable (${statSync(binary).size} bytes)`)
    check(existsSync(join(dir, 'LICENSE')), `${suffix} carries LICENSE`)
    check(existsSync(join(dir, 'THIRD-PARTY-NOTICES.md')), `${suffix} carries THIRD-PARTY-NOTICES.md`)
    // 平台包是单独发布的：许可证必须和主包逐字节一致，不能是另一份手抄的。
    check(
      existsSync(join(dir, 'LICENSE')) &&
        readFileSync(join(dir, 'LICENSE')).equals(readFileSync(join(packageRoot, 'LICENSE'))),
      `${suffix} carries the same LICENSE bytes as the main package`,
    )
    check(
      platformManifest.author === manifest.author,
      `${suffix} inherits the main package author`,
      String(platformManifest.author),
    )
    check(platformManifest.license === manifest.license, `${suffix} inherits license: ${manifest.license}`)
  } else {
    check(false, `${suffix} binary is where repoTutor.core says`, `missing ${binary}`)
  }
}

// ── 5. 隔离打包（每个包一个输出目录，互不共享）────────────────────────────

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const packRoot = join(distRoot, 'rc', stamp)
mkdirSync(packRoot, { recursive: true })

function pack(label, packageDir) {
  // 每次打包一个独占目录：并发跑本脚本不会有两个 npm pack 写同一个位置。
  const outDir = join(packRoot, label)
  mkdirSync(outDir, { recursive: true })
  const result = npm(['pack', '--json', '--pack-destination', outDir], { cwd: packageDir })
  if (result.error || result.status !== 0) {
    check(false, `npm pack ${label}`, `${result.error ?? ''} ${(result.stderr ?? '').trim()}`.trim().slice(0, 400))
    return undefined
  }
  const output = String(result.stdout ?? '').trim()
  if (output === '') {
    check(false, `npm pack ${label} produced a tarball name`, 'npm printed nothing to stdout')
    return undefined
  }
  const [info] = JSON.parse(output)
  const tarball = join(outDir, info.filename)
  check(existsSync(tarball), `npm pack ${label} wrote ${info.filename}`)
  return { tarball, info, label }
}

const packed = []
for (const target of publishable) {
  const dir = platformDirs.get(target)
  if (dir === undefined) continue
  const result = pack(suffixOf(target), dir)
  if (result !== undefined) packed.push(result)
}
const mainPacked = pack('main', packageRoot)
if (mainPacked !== undefined) packed.push(mainPacked)

// ── 6. tarball 清单与敏感文件 ─────────────────────────────────────────────

const REQUIRED_MAIN = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/THIRD-PARTY-NOTICES.md',
  'package/cordis.patch.yml',
  'package/platforms.config.json',
  'package/src/index.js',
  'package/src/core-client.mjs',
  'package/src/platform-core.mjs',
  'package/policies/tutor-prompt.md',
  'package/preset/preset.yml',
  'package/preset/agent.cordis.yml',
  'package/scripts/install-preset.mjs',
  'package/scripts/verify-package.mjs',
]

// 敏感文件与仓库内务：一个都不许进包。
const FORBIDDEN = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)\.env/,
  /(^|\/)\.npmrc/,
  /(^|\/)overlay\.local\.yml$/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)id_(rsa|ed25519)/,
  /(^|\/)credentials/i,
  /(^|\/)test\//,
  /(^|\/)dist\//,
  /\.tgz$/,
  /\.log$/,
  /(^|\/)\.dsh\//,
]

// 唯一正确的署名写法；LICENSE 里那行必须逐字等于它，别处不许出现别的署名。
const COPYRIGHT_HOLDER = 'Wang-yifan666'
const COPYRIGHT_LINE = `Copyright (c) 2026 ${COPYRIGHT_HOLDER}`

// 文件名挡得住的东西之外，还要读一遍内容：凭据和「这台机器」的痕迹。
const CONTENT_LEAKS = [
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'openai-style key', pattern: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'github token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'aws key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'windows user path', pattern: /[A-Za-z]:\\\\?Users\\\\?[A-Za-z0-9._-]+/ },
  { name: 'posix home path', pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+\// },
].map((entry) => ({
  ...entry,
  // exec 的 lastIndex 会跨文件残留，所以每次用一个新的字面量。
  exec: (text) => new RegExp(entry.pattern.source, entry.pattern.flags).exec(text),
}))

for (const { tarball, info, label } of packed) {
  const listed = run('tar', ['-tzf', tarball])
  // Windows 的 tar 输出是 CRLF，按 \n 切会把 \r 留在每一条结尾，后面一条都对不上。
  const entries = listed.status === 0 ? listed.stdout.trim().split(/\r?\n/) : []
  check(entries.length > 0, `${label} tarball lists ${entries.length} entries`)

  const leaks = entries.filter((entry) => FORBIDDEN.some((pattern) => pattern.test(entry)))
  check(leaks.length === 0, `${label} tarball carries no sensitive or repo-only file`, leaks.join(', '))

  // 文件名单过了不算数：真解出来读一遍，找凭据和本机绝对路径。
  const extractDir = join(packRoot, `${label}-unpacked`)
  mkdirSync(extractDir, { recursive: true })
  const untar = run('tar', ['-xzf', tarball, '-C', extractDir])
  check(untar.status === 0, `${label} tarball extracts`)
  const found = []
  const narrative = new Map()
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      if (statSync(full).size > 2_000_000) continue // 二进制跳过
      let text
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (text.includes('\u0000')) continue
      for (const pattern of CONTENT_LEAKS) {
        const match = pattern.exec(text)
        if (match !== null) found.push(`${relative(extractDir, full)}: ${match[0].slice(0, 60)}`)
      }
      // 署名只有一个正确写法：许可证里那行必须是它，别的任何版权行都说明有人抄了旧版本。
      if (/(^|[\\/])(LICENSE|README\.md|THIRD-PARTY-NOTICES\.md|package\.json)$/i.test(full)) {
        narrative.set(relative(extractDir, full).replaceAll('\\', '/'), text)
      }
    }
  }
  walk(extractDir)
  check(found.length === 0, `${label} tarball content has no credentials or machine-specific paths`, found.join('\n      '))

  // 许可证那一行必须逐字相等；别处出现任何不是这个署名的版权行，都算没清干净。
  const licence = narrative.get('package/LICENSE') ?? ''
  const licenceLines = licence.split(/\r?\n/).filter((line) => line.includes('Copyright (c)'))
  check(
    licenceLines.length === 1 && licenceLines[0].trim() === COPYRIGHT_LINE,
    `${label} LICENSE states exactly "${COPYRIGHT_LINE}"`,
    JSON.stringify(licenceLines),
  )
  const staleLines = []
  for (const [file, text] of narrative) {
    if (file === 'package/LICENSE') continue
    for (const line of text.split(/\r?\n/)) {
      // 只有「2026 后面不是这个署名」才算问题；说明文里引用正确写法的句子不受影响。
      if (/Copyright \(c\) \d{4} (?!Wang-yifan666\b)/.test(line)) staleLines.push(`${file}: ${line.trim()}`)
    }
  }
  check(
    staleLines.length === 0,
    `${label} tarball restates no other copyright holder`,
    staleLines.join('\n      '),
  )

  const digest = sha256(tarball)
  console.log(`      ${info.filename}  files=${entries.length}  size=${info.size}  sha256=${digest.slice(0, 16)}…`)

  if (label === 'main') {
    const set = new Set(entries)
    for (const required of REQUIRED_MAIN) {
      check(set.has(required), `main tarball contains ${required}`)
    }
    check(!entries.some((entry) => entry.includes('package/bin/')), 'main tarball has no vendored binary')
  } else {
    const coreEntry = entries.find((entry) => entry.startsWith('package/bin/'))
    check(coreEntry !== undefined, `${label} tarball carries the binary`, entries.join(', '))
    check(entries.includes('package/LICENSE'), `${label} tarball carries LICENSE`)
    check(entries.includes('package/checksums.txt'), `${label} tarball carries checksums.txt`)
  }
}

// ── 7. 完整性清单 ─────────────────────────────────────────────────────────

const sumsPath = join(packRoot, 'SHA256SUMS')
const sums = packed.map(({ tarball, info }) => `${sha256(tarball)}  ${info.filename}`).join('\n')
writeFileSync(sumsPath, `${sums}\n`)
console.log(`\nSHA256SUMS -> ${sumsPath}`)
for (const line of sums.split('\n')) console.log(`  ${line}`)

// ── 8. npm publish --dry-run（顺序：平台包先，主包最后）────────────────────

if (runDryRun) {
  console.log('\n# npm publish --dry-run')
  for (const { label } of packed) {
    const dir = label === 'main' ? packageRoot : platformDirs.get(publishable.find((t) => suffixOf(t) === label))
    const result = npm(['publish', '--dry-run', '--tag', expectedTag], { cwd: dir })
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
    check(
      result.status === 0,
      `npm publish --dry-run ${label} (--tag ${expectedTag})`,
      text.trim().split('\n').slice(-6).join('\n      '),
    )
    // npm 会自己打一行「with tag npm-picked-tag」，用它确认标签真的按命令走了。
    const tag = /with tag (\S+)/.exec(text)
    check(
      tag !== null && tag[1] === expectedTag,
      `${label} dry-run would publish under tag "${expectedTag}"`,
      tag === null ? 'npm printed no tag line' : `npm printed tag "${tag[1]}"`,
    )
    // npm 在发布时会「顺手修正」manifest；被修正过的包发出去就不是我们审过的那个了。
    const warnings = text.split('\n').filter((line) => line.includes('npm warn publish'))
    check(warnings.length === 0, `${label} needs no manifest auto-correction`, warnings.join('\n      '))
  }
}

// ── 发布顺序 ─────────────────────────────────────────────────────────────

console.log('\n# publish order (platform packages first, main package last)')
console.log('# 发的是上面这份 tgz，不是目录：这样 registry 上的字节就是我们算过 SHA-256 的那一份。')
let step = 1
for (const { label, info } of packed) {
  if (label === 'main') continue
  const access = label === 'main' ? '' : ' --access public'
  console.log(`  ${step++}. npm publish ${join(packRoot, info.filename)} --tag ${expectedTag}${access}`)
}
console.log(`  ${step}. npm publish ${join(packRoot, mainPacked.info.filename)} --tag ${expectedTag}`)

console.log(`\n${failures === 0 ? 'release check passed' : `${failures} release check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
