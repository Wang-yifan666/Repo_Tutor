#!/usr/bin/env node
// 发布前自检：这个包能不能装、装上之后还找不找得到自己的文件。
//
// 它不联网、不发布，只做六件事：
//   1. 校验 package.json 的发布元数据和 dsh.bundle manifest
//   2. npm pack --dry-run，核对文件白名单（该有的有，仓库里的东西没有）
//   3. 真的 npm pack，解开 tarball
//   4. 在解包目录里跑导师模式安装器（DSH_HOME 指向临时目录，不碰用户的）
//   5. 没有 REPO_TUTOR_CORE 时，apply 必须报一条说清楚下一步的错误
//   6. 给了 Core 时，用假 ctx 装上插件并从 Core 拿一次真实状态
//
// 用法：node scripts/verify-package.mjs [--core <repo-tutor-core 路径>]
// 退出码：0 全部通过，1 有断言失败，2 用法错误。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'repo-tutor-verify-'))

let failures = 0
const checks = []
function check(condition, message) {
  checks.push({ ok: Boolean(condition), message })
  if (!condition) failures += 1
}

// ── 参数 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let corePath = process.env.REPO_TUTOR_CORE
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--core') {
    corePath = argv[i + 1]
    i += 1
  } else {
    console.error(`usage: verify-package.mjs [--core <path>]  (unknown argument ${argv[i]})`)
    process.exit(2)
  }
}
if (corePath !== undefined && !existsSync(corePath)) {
  console.error(`error: --core does not exist: ${corePath}`)
  process.exit(2)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 180000, ...options })
}

// Windows 上 npm 是 npm.cmd，直接 spawn 会 EINVAL，得借 shell；借了 shell 就要自己加引号。
const isWindows = process.platform === 'win32'
function npm(args, options = {}) {
  const command = isWindows ? 'npm.cmd' : 'npm'
  const safe = isWindows ? args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)) : args
  return run(command, safe, { shell: isWindows, ...options })
}

try {
  // ── 1. 元数据 ───────────────────────────────────────────────────────────

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  for (const field of [
    'name',
    'version',
    'description',
    'license',
    'repository',
    'keywords',
    'engines',
    'files',
  ]) {
    check(manifest[field] !== undefined && manifest[field] !== '', `package.json declares ${field}`)
  }
  check(manifest.type === 'module', 'package is an ES module package')
  check(
    manifest.dsh?.bundle?.patch === './cordis.patch.yml',
    'dsh.bundle.patch manifest is preserved and points at cordis.patch.yml',
  )
  check(
    typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh !== '',
    'engines.dsh is declared (compatibility is documented, not guessed at runtime)',
  )
  check(
    typeof manifest.engines?.node === 'string',
    'engines.node is declared',
  )
  check(existsSync(join(packageRoot, 'LICENSE')), 'LICENSE ships with the package')
  check(
    existsSync(join(packageRoot, 'THIRD-PARTY-NOTICES.md')),
    'THIRD-PARTY-NOTICES.md records the statically linked C++ runtime',
  )
  if (existsSync(join(packageRoot, '..', '..', 'LICENSE'))) {
    check(
      readFileSync(join(packageRoot, 'LICENSE'), 'utf8') ===
        readFileSync(join(packageRoot, '..', '..', 'LICENSE'), 'utf8'),
      'the package LICENSE is the repository LICENSE, not a drifting copy',
    )
  }
  const licenceText = readFileSync(join(packageRoot, 'LICENSE'), 'utf8')
  check(manifest.license === 'MIT', 'the package declares the MIT licence', String(manifest.license))
  check(
    licenceText.includes('Copyright (c) 2026 Wang-yifan666'),
    'LICENSE carries the maintainer copyright line (the GitHub handle, one spelling only)',
  )
  check(
    typeof manifest.author === 'string' && manifest.author.includes('Wang-yifan666'),
    'package.json author names the same handle as LICENSE',
    String(manifest.author),
  )
  check(existsSync(join(packageRoot, 'README.md')), 'README.md ships with the package')
  check(
    existsSync(join(packageRoot, 'policies', 'tutor-prompt.md')),
    'the teaching prompt lives inside the package (policies/tutor-prompt.md)',
  )
  check(
    !existsSync(join(packageRoot, '..', '..', 'policies', 'tutor-prompt.md')),
    'the teaching prompt is not duplicated outside the package',
  )

  // 发布闸门：依赖表说明「我们会发布什么」，所以它必须等于可发布平台集合。
  const platforms = JSON.parse(readFileSync(join(packageRoot, 'platforms.config.json'), 'utf8'))
  const publishable = platforms.targets
    .filter((target) => target.publish !== false)
    .map((target) => `${platforms.scope}/core-${target.platform}-${target.arch}`)
    .sort()
  const declared = Object.keys(manifest.optionalDependencies ?? {}).sort()
  check(
    JSON.stringify(declared) === JSON.stringify(publishable),
    'optionalDependencies lists exactly the publishable platforms',
    `declared ${declared.join(', ')} / publishable ${publishable.join(', ')}`,
  )
  for (const name of declared) {
    check(
      manifest.optionalDependencies[name] === manifest.version,
      `${name} is pinned to ${manifest.version} (no range, no drift)`,
      `declares ${manifest.optionalDependencies[name]}`,
    )
  }
  check(
    manifest.publishConfig?.access === 'public',
    'publishConfig.access is public (a scoped publish without it lands private)',
  )
  check(
    manifest.publishConfig?.tag === (manifest.version.includes('-') ? 'next' : 'latest'),
    `publishConfig.tag matches the version channel (${manifest.version})`,
    `tag is ${String(manifest.publishConfig?.tag)}`,
  )


  // ── 2. npm pack --dry-run：文件白名单 ───────────────────────────────────

  const dryRun = npm(['pack', '--dry-run', '--json'], { cwd: packageRoot })
  if (dryRun.status !== 0) {
    check(false, `npm pack --dry-run failed: ${(dryRun.stderr ?? '').trim().slice(0, 400)}`)
  } else {
    const [info] = JSON.parse(dryRun.stdout)
    const shipped = new Set(info.files.map((file) => file.path))
    for (const required of [
      'package.json',
      'README.md',
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
      'cordis.patch.yml',
      'platforms.config.json',
      'src/index.js',
      'src/core-client.mjs',
      'policies/tutor-prompt.md',
      'preset/preset.yml',
      'preset/agent.cordis.yml',
      'scripts/install-preset.mjs',
      'scripts/verify-package.mjs',
    ]) {
      check(shipped.has(required), `tarball contains ${required}`)
    }
    for (const forbidden of ['test/client-smoke.mjs', 'test/plugin-wiring.mjs', 'overlay.local.yml']) {
      check(!shipped.has(forbidden), `tarball leaves out repo-only file ${forbidden}`)
    }
    console.log(`files in package: ${info.files.length}, unpacked ${info.unpackedSize} bytes`)
  }

  // ── 3. 真的 pack 并解开 ─────────────────────────────────────────────────

  const packed = npm(['pack', '--json', '--pack-destination', work], { cwd: packageRoot })
  if (packed.status !== 0) {
    check(false, `npm pack failed: ${(packed.stderr ?? '').trim().slice(0, 400)}`)
    throw new Error('cannot continue without a tarball')
  }
  const tarball = join(work, JSON.parse(packed.stdout)[0].filename)
  const extracted = join(work, 'unpacked')
  mkdirSync(extracted, { recursive: true })
  const untar = run('tar', ['-xzf', tarball, '-C', extracted])
  check(untar.status === 0, 'tarball extracts')
  const installed = join(extracted, 'package')
  check(existsSync(join(installed, 'src', 'index.js')), 'extracted package has src/index.js')
  check(
    existsSync(join(installed, 'policies', 'tutor-prompt.md')),
    'extracted package carries the teaching prompt',
  )
  console.log(`tarball: ${tarball}`)

  // ── 4. 解包目录里跑导师模式安装器 ───────────────────────────────────────

  const fakeHome = join(work, 'dsh-home')
  const install = run(process.execPath, [join(installed, 'scripts', 'install-preset.mjs')], {
    env: { ...process.env, DSH_HOME: fakeHome, REPO_TUTOR_CORE: '' },
  })
  check(install.status === 0, `install-preset runs from the unpacked package: ${(install.stderr ?? '').trim().slice(0, 300)}`)

  const presetDir = join(fakeHome, '.agent-presets', 'repo-tutor')
  const compositionPath = join(presetDir, 'agent.cordis.yml')
  if (existsSync(compositionPath)) {
    const composition = readFileSync(compositionPath, 'utf8')
    check(
      composition.includes("name: './plugin/src/index.js'"),
      'preset row uses a preset-relative specifier (never a package name or absolute path)',
    )
    check(
      !/^\s+name:.*[A-Za-z]:[\\/]/m.test(composition),
      'preset row carries no absolute Windows path',
    )
    check(composition.includes('alwaysOn: true'), 'preset enables alwaysOn')
    check(composition.includes('blockBypassTools: true'), 'preset enables blockBypassTools')
    check(
      existsSync(join(presetDir, 'plugin', 'src', 'index.js')),
      'plugin sources are vendored into the preset directory',
    )
    check(
      existsSync(join(presetDir, 'plugin', 'policies', 'tutor-prompt.md')),
      'teaching prompt is vendored into the preset directory',
    )
  } else {
    check(false, 'install-preset wrote agent.cordis.yml')
  }

  // ── 5 & 6. 在解包目录里真装上插件 ───────────────────────────────────────

  const harnessScript = join(work, 'harness.mjs')
  writeFileSync(
    harnessScript,
    `import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [pluginPath, corePath, mode] = process.argv.slice(2)
const plugin = await import(pluginPath)

const tools = new Map()
const sections = []
const commands = []
const deferred = []
const disposers = []
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  effect: (factory) => {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  get: () => undefined,
  on: () => () => {},
  inject: (deps, callback) => {
    deferred.push({ deps, callback })
    return () => {}
  },
}

try {
  plugin.apply(ctx, { alwaysOn: true, blockBypassTools: false })
} catch (error) {
  if (mode === 'expect-core-error') {
    const message = String(error.message ?? error)
    if (!message.includes('repo-tutor-core not found') || !message.includes('REPO_TUTOR_CORE')) {
      console.log('FAIL: error does not name REPO_TUTOR_CORE:', message)
      process.exit(1)
    }
    console.log('OK: missing core reports:', message.slice(0, 160))
    process.exit(0)
  }
  console.log('FAIL: apply threw unexpectedly:', error.message)
  process.exit(1)
}

if (mode === 'expect-core-error') {
  // Lazy resolution: apply succeeding is by design; the error must be explicit at use time.
  // Resolve siblings from the plugin entry URL passed in argv, not from this harness file.
  const { findPlatformCore, missingPlatformCoreMessage } = await import(new URL('./platform-core.mjs', pluginPath).href)
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', pluginPath), 'utf8'))
  const message = missingPlatformCoreMessage(manifest, findPlatformCore(manifest, { requireFrom: pluginPath }))
  if (!message.includes('REPO_TUTOR_CORE') || !message.includes('corePath')) {
    console.log('FAIL: the lazy error does not name the escape hatches:', message)
    process.exit(1)
  }
  console.log('OK: lazy missing-core error names REPO_TUTOR_CORE and corePath')
  process.exit(0)
}

for (const { deps, callback } of deferred) {
  callback({
    systemPrompt: { section: (section) => sections.push(section) },
    commands: { register: (definition) => commands.push(definition) },
  })
}

const problems = []
if (tools.size !== 11) problems.push('expected 11 tools, got ' + tools.size)
if (sections.length !== 1) problems.push('expected one prompt section')
const text = typeof sections[0]?.text === 'function' ? sections[0].text() : sections[0]?.text ?? ''
if (!text.includes('## Repo Tutor')) problems.push('prompt section lost its heading')
if (!text.includes('1000 Chinese characters')) problems.push('prompt section did not read the shipped prompt file')
if (commands.length !== 1) problems.push('expected the /tutor command')

const root = mkdtempSync(join(tmpdir(), 'repo-tutor-verify-fixture-'))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'src', 'main.cpp'), 'int main() { return 0; }\\n')

const exec = { agent: { session: { header: { cwd: root } } } }
const status = await tools.get('tutor_status').execute({}, exec)
if (status?.root?.replaceAll('\\\\', '/').toLowerCase() !== root.replaceAll('\\\\', '/').toLowerCase()) {
  problems.push('tutor_status reported the wrong root: ' + JSON.stringify(status))
}
const scan = await tools.get('tutor_scan_repository').execute({}, exec)
if (scan?.status !== 'scanned' || scan.fileCount !== 1) problems.push('scan did not reach the Core: ' + JSON.stringify(scan))

for (const dispose of disposers) dispose()
rmSync(root, { recursive: true, force: true })

if (problems.length > 0) {
  console.log('FAIL: ' + problems.join('; '))
  process.exit(1)
}
console.log('OK: 11 tools, prompt section, /tutor command, live Core round-trip')
`,
  )

  const noCore = run(process.execPath, [harnessScript, pathToFileURL(join(installed, 'src', 'index.js')).href, '', 'expect-core-error'], {
    env: { ...process.env, REPO_TUTOR_CORE: '' },
  })
  check(
    noCore.status === 0 && (noCore.stdout ?? '').includes('OK:'),
    `a package without a core fails with an actionable error: ${`${noCore.stdout ?? ''}${noCore.stderr ?? ''}`.trim().slice(0, 400)}`,
  )

  if (corePath === undefined) {
    checks.push({
      ok: true,
      message: 'SKIPPED live round-trip: no --core / REPO_TUTOR_CORE given',
    })
  } else {
    const withCore = run(process.execPath, [harnessScript, pathToFileURL(join(installed, 'src', 'index.js')).href, corePath, 'run'], {
      env: { ...process.env, REPO_TUTOR_CORE: corePath },
    })
    check(
      withCore.status === 0 && (withCore.stdout ?? '').includes('OK:'),
      `the unpacked package drives a real Core: ${`${withCore.stdout ?? ''}${withCore.stderr ?? ''}`.trim().slice(0, 400)}`,
    )
  }
} catch (error) {
  check(false, `verification crashed: ${error.message}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

// ── 结果 ──────────────────────────────────────────────────────────────────

for (const { ok, message } of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`)
}
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`)
process.exit(failures === 0 ? 0 : 1)
