#!/usr/bin/env node
// 生成平台 Core 包：dist/platforms/<os>-<arch>/{package.json, bin/<exe>, checksums.txt}
//
// 主包用 optionalDependencies 精确锁版本，平台包声明 { repoTutor: { core, protocolVersion } }，
// 插件按这两个字段解析，不猜文件名。CI 的每个原生 runner 各跑一次本脚本产出自己那一份。
//
// 用法：
//   node scripts/make-platform-packages.mjs --core <构建出的可执行文件> [--platform win32-x64]
//   node scripts/make-platform-packages.mjs --sync        # 只同步主包的 optionalDependencies
//   REPO_TUTOR_NPM_SCOPE=@my-scope                        # 换 scope，不用改代码

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(packageRoot, 'package.json')
const configPath = join(packageRoot, 'platforms.config.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const scope = process.env.REPO_TUTOR_NPM_SCOPE ?? config.scope
const version = manifest.version
const protocolVersion = config.protocolVersion ?? manifest.repoTutor?.protocolVersion ?? '0.1'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const packageNameFor = (target) => `${scope}/core-${target.platform}-${target.arch}`
const suffixFor = (target) => `${target.platform}-${target.arch}`

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(2)
}

// ── --sync：把主包的 optionalDependencies 对齐到 config + 版本 ────────────

function syncDependencies() {
  const optional = {}
  for (const target of config.targets) {
    // publish=false 的平台只是构建目标，不进依赖：依赖表就是「我们会发布什么」。
    if (target.publish === false) continue
    // 精确版本：平台包和主包必须同号，协议才保证一致。
    optional[packageNameFor(target)] = version
  }
  const next = { ...manifest, optionalDependencies: optional }
  next.repoTutor = {
    ...(next.repoTutor ?? {}),
    protocolVersion,
    platformsConfig: 'platforms.config.json',
  }
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`synced ${Object.keys(optional).length} optionalDependencies at ${version} (scope ${scope})`)
}

if (argv.includes('--sync')) {
  syncDependencies()
  process.exit(0)
}

// ── 平台识别 ──────────────────────────────────────────────────────────────

const platformArg = flag('--platform') ?? `${process.platform}-${process.arch}`
const target = config.targets.find((entry) => suffixFor(entry) === platformArg)
if (target === undefined) fail(`platform ${platformArg} is not in platforms.config.json`)

// 未验证的平台不出包：出包就该发布，而 publish=false 说的是「我们还不敢发布它」。
if (target.publish === false && !argv.includes('--allow-unpublished')) {
  fail(
    `${platformArg} is marked publish=false in platforms.config.json` +
      (target.unverified === undefined ? '' : ` (${target.unverified})`) +
      '\n  It can still be built and tested, but no npm package is derived from it until it is\n' +
      '  verified on a native runner. Pass --allow-unpublished to produce a local-only package.',
  )
}

const coreArg = flag('--core')
if (coreArg === undefined) fail('--core <path> is required (the executable built for this platform)')
const corePath = resolve(coreArg)
if (!existsSync(corePath)) fail(`--core does not exist: ${corePath}`)

// ── 动态库依赖检查 ────────────────────────────────────────────────────────

/** 允许的动态库：只剩系统库才算能单独分发。 */
const ALLOWED = {
  win32: [/^kernel32\.dll$/i, /^msvcrt\.dll$/i, /^api-ms-win-/i, /^user32\.dll$/i],
  linux: [/^libc\.so\.6$/, /^libm\.so\.6$/, /^libgcc_s\.so/, /^libstdc\+\+\.so/, /^ld-linux/, /^\/lib64\/ld-linux/, /^linux-vdso\.so/],
  darwin: [/^\/usr\/lib\//, /^\/System\/Library\//],
}

function listDependencies(platform) {
  if (platform === 'win32') {
    // MinGW 环境用 objdump，MSVC runner 用 dumpbin；两边都要能跑。
    try {
      const output = execFileSync('objdump', ['-p', corePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      return [...output.matchAll(/DLL Name:\s*(\S+)/g)].map((match) => match[1])
    } catch {
      const output = execFileSync('dumpbin', ['/dependents', corePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      return [...output.matchAll(/^\s+(\S+\.dll)\s*$/gim)].map((match) => match[1])
    }
  }
  if (platform === 'linux') {
    const output = execFileSync('ldd', [corePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return output
      .split('\n')
      .map((line) => line.trim().split(' ')[0])
      .filter((name) => name.includes('.so'))
  }
  const output = execFileSync('otool', ['-L', corePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0])
    .filter((name) => name !== '')
}

let dependencies = []
try {
  dependencies = listDependencies(target.platform)
} catch (error) {
  fail(`dependency check failed for ${platformArg}: ${error.message}`)
}

const allowed = ALLOWED[target.platform] ?? []
const unexpected = dependencies.filter((name) => !allowed.some((pattern) => pattern.test(name)))
if (unexpected.length > 0) {
  fail(
    `${platformArg} binary depends on non-system libraries: ${unexpected.join(', ')}\n` +
      '  Link the C++ runtime statically (REPO_TUTOR_STATIC_RUNTIME=ON) — a binary that needs\n' +
      '  libstdc++/libgcc/winpthread at runtime fails on machines without a toolchain.',
  )
}

// ── 可执行性检查 ──────────────────────────────────────────────────────────

if (target.platform !== 'win32') {
  chmodSync(corePath, 0o755)
  const mode = statSync(corePath).mode & 0o777
  if ((mode & 0o111) === 0) fail(`binary is not executable (mode ${mode.toString(8)})`)
}

try {
  // 用协议本身做一次冒烟：发一条 negotiate，看它回不回答。
  const probe = execFileSync(corePath, [], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'protocol.negotiate', params: {} })}\n`,
    encoding: 'utf8',
    timeout: 30000,
  })
  const line = probe.trim().split('\n').at(-1)
  const negotiated = JSON.parse(line)
  if (negotiated.result?.protocolVersion !== protocolVersion) {
    fail(
      `binary negotiates protocol ${String(negotiated.result?.protocolVersion)}, ` +
        `but this package targets ${protocolVersion}`,
    )
  }
} catch (error) {
  fail(`the binary could not answer protocol.negotiate: ${error.message}`)
}

// ── 产出平台包 ────────────────────────────────────────────────────────────

const suffix = suffixFor(target)
const outDir = join(packageRoot, 'dist', 'platforms', suffix)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'bin'), { recursive: true })

const binRel = join('bin', target.bin)
copyFileSync(corePath, join(outDir, binRel))
if (target.platform !== 'win32') chmodSync(join(outDir, binRel), 0o755)

const sha = createHash('sha256').update(readFileSync(join(outDir, binRel))).digest('hex')
writeFileSync(join(outDir, 'checksums.txt'), `${sha}  ${binRel.replaceAll('\\', '/')}\n`)

// 平台包也单独发布，所以它得自己带上许可证与第三方声明 —— npm 不会替你跨包继承。
copyFileSync(join(packageRoot, 'LICENSE'), join(outDir, 'LICENSE'))
copyFileSync(join(packageRoot, 'THIRD-PARTY-NOTICES.md'), join(outDir, 'THIRD-PARTY-NOTICES.md'))

const platformManifest = {
  name: packageNameFor(target),
  version,
  description: `repo-tutor-core (${suffix}) — the C++ teaching core for repo-tutor-dsh`,
  license: manifest.license,
  author: manifest.author,
  homepage: manifest.homepage,
  repository: manifest.repository,
  os: [target.platform],
  cpu: [target.arch],
  files: ['bin', 'checksums.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
  repoTutor: {
    core: binRel.replaceAll('\\', '/'),
    protocolVersion,
  },
  // 平台包是 scope 包，没有 access: public 会被发成私有；tag 由版本推导，避免 RC 落到 latest。
  publishConfig: {
    access: 'public',
    tag: version.includes('-') ? 'next' : 'latest',
  },
}
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(platformManifest, null, 2)}\n`)

console.log(`platform package: ${platformManifest.name}@${version}`)
console.log(`  dir        : ${outDir}`)
console.log(`  binary     : ${binRel} (${statSync(join(outDir, binRel)).size} bytes)`)
console.log(`  sha256     : ${sha}`)
console.log(`  deps       : ${dependencies.join(', ')}`)
console.log(`  protocol   : ${protocolVersion}`)
if (target.unverified !== undefined) {
  console.log(`  WARNING    : ${target.unverified}`)
}
