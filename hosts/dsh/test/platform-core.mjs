// 平台包的验收：解析、缺包报错、--core 覆盖、升级不残留旧二进制、协议握手。
//
// 全部在临时目录里做，不碰真实的 $DSH_HOME / profile，也不需要 DSH 进程。
//
// 用法：node hosts/dsh/test/platform-core.mjs [--core <repo-tutor-core>]
//   不给 --core 就用 build/<preset>/apps/repo-tutor-core 里的构建产物。

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const isWindows = process.platform === 'win32'
const suffix = `${process.platform}-${process.arch}`

let failures = 0
function check(condition, message, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}${condition || detail === undefined ? '' : `\n      ${detail}`}`)
  if (!condition) failures += 1
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600000, ...options })
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function npm(args, options) {
  const command = isWindows ? 'npm.cmd' : 'npm'
  const safe = isWindows ? args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)) : args
  return run(command, safe, { shell: isWindows, ...options })
}

const presetArgIndex = process.argv.indexOf('--core')
const corePath =
  presetArgIndex === -1
    ? join(repoRoot, 'build', isWindows ? 'dev-mingw' : 'dev', 'apps', 'repo-tutor-core', isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core')
    : resolve(process.argv[presetArgIndex + 1])
if (!existsSync(corePath)) {
  console.log(`SKIPPED: repo-tutor-core not built at ${corePath}`)
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'repo-tutor-platform-'))
const packDir = join(work, 'pack')
mkdirSync(packDir, { recursive: true })

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// 用户真实 preset 目录的指纹：整个测试期间它必须一动不动。
const realHome = process.env.DSH_HOME_REAL ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const realPreset = join(realHome, '.agent-presets', 'repo-tutor')
function fingerprint(dir) {
  if (!existsSync(dir)) return 'absent'
  const files = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name), `${prefix}${entry.name}/`)
      else files.push(`${prefix}${entry.name}:${sha256(join(current, entry.name))}`)
    }
  }
  walk(dir, '')
  return `${files.sort().join('|')}`.length + ':' + createHash('sha256').update(files.sort().join('|')).digest('hex')
}
const realFingerprint = fingerprint(realPreset)

try {
  // ── 1. 生成平台包 ──────────────────────────────────────────────────────
  const made = run(process.execPath, [join(packageRoot, 'scripts', 'make-platform-packages.mjs'), '--core', corePath])
  check(made.status === 0, 'make-platform-packages builds the platform package', made.out.slice(-400))
  const platformDir = join(packageRoot, 'dist', 'platforms', suffix)
  check(existsSync(join(platformDir, 'package.json')), 'platform package.json exists')
  const platformManifest = JSON.parse(readFileSync(join(platformDir, 'package.json'), 'utf8'))
  const mainManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  check(
    platformManifest.version === mainManifest.version,
    'platform package version equals the main package version',
    `${platformManifest.version} vs ${mainManifest.version}`,
  )
  check(
    mainManifest.optionalDependencies?.[platformManifest.name] === mainManifest.version,
    'the main package pins the platform package at an exact version',
    JSON.stringify(mainManifest.optionalDependencies),
  )
  check(
    platformManifest.repoTutor?.protocolVersion === mainManifest.repoTutor?.protocolVersion,
    'protocol versions match between packages',
  )

  // ── 2. pack 两份 tarball ───────────────────────────────────────────────
  const packedPlatform = npm(['pack', '--json', '--pack-destination', packDir], { cwd: platformDir })
  const packedMain = npm(['pack', '--json', '--pack-destination', packDir], { cwd: packageRoot })
  check(packedPlatform.status === 0, 'platform package packs', packedPlatform.out.slice(-300))
  check(packedMain.status === 0, 'main package packs', packedMain.out.slice(-300))
  const platformTgz = join(packDir, JSON.parse(packedPlatform.out.replace(/^[^[]*/, '')).at(0).filename)
  const mainTgz = join(packDir, JSON.parse(packedMain.out.replace(/^[^[]*/, '')).at(0).filename)

  // ── 3. A：装完能从 npm 依赖解析到平台 Core ────────────────────────────
  const appA = join(work, 'app-a')
  mkdirSync(appA, { recursive: true })
  writeFileSync(join(appA, 'package.json'), '{"name":"probe-a","private":true}\n')
  const installed = npm(['install', '--no-audit', '--no-fund', '--loglevel=error', platformTgz, mainTgz], { cwd: appA })
  check(installed.status === 0, 'A: installing both tarballs succeeds', installed.out.slice(-500))
  const probeA = join(appA, 'probe.mjs')
  writeFileSync(
    probeA,
    `import { findPlatformCore } from 'repo-tutor-dsh/src/platform-core.mjs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const manifest = JSON.parse(readFileSync(new URL('./node_modules/repo-tutor-dsh/package.json', import.meta.url)))
const found = findPlatformCore(manifest, { requireFrom: new URL('./node_modules/repo-tutor-dsh/src/index.js', import.meta.url) })
console.log(JSON.stringify(found))
`,
  )
  const probeResult = run(process.execPath, [probeA], { cwd: appA, env: { ...process.env, REPO_TUTOR_CORE: '' } })
  let resolved
  try {
    resolved = JSON.parse(probeResult.out.trim().split('\n').at(-1))
  } catch {
    resolved = {}
  }
  check(
    typeof resolved.path === 'string' && resolved.path.includes(platformManifest.name.replace('/', isWindows ? '\\' : '/')),
    'A: the plugin resolves the Core from its own optionalDependency',
    probeResult.out.slice(-400),
  )
  check(resolved.protocolVersion === mainManifest.repoTutor.protocolVersion, 'A: resolved Core carries the protocol version')

  // 真的把它跑起来：一个最小 JSON-RPC 往返
  const liveA = run(
    process.execPath,
    ['-e', `const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(resolved.path)}, [], { stdio: ['pipe','pipe','inherit'] });
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'protocol.negotiate',params:{}})+'\\n');
let out='';
child.stdout.on('data', (d) => { out += d.toString(); child.kill(); });
child.on('exit', () => { console.log(out.trim()); });`],
    { cwd: appA },
  )
  check(liveA.out.includes('"protocolVersion":"0.1"'), 'A: the resolved binary answers the protocol', liveA.out.slice(-200))

  // ── 4. D：--omit=optional 时给出明确错误 ──────────────────────────────
  const appD = join(work, 'app-d')
  mkdirSync(appD, { recursive: true })
  writeFileSync(join(appD, 'package.json'), '{"name":"probe-d","private":true}\n')
  const noOptional = npm(['install', '--no-audit', '--no-fund', '--loglevel=error', '--omit=optional', mainTgz], { cwd: appD })
  check(noOptional.status === 0, 'D: installing with --omit=optional succeeds', noOptional.out.slice(-300))
  const probeD = join(appD, 'probe.mjs')
  writeFileSync(
    probeD,
    `// 惰性解析：apply 不再抛错（那会让整行静默 never started），错误必须在"用"的时候明确出现。
const { findPlatformCore, missingPlatformCoreMessage } = await import('repo-tutor-dsh/src/platform-core.mjs')
const { readFileSync } = await import('node:fs')
const manifest = JSON.parse(readFileSync(new URL('./node_modules/repo-tutor-dsh/package.json', import.meta.url)))
const found = findPlatformCore(manifest, { requireFrom: new URL('./node_modules/repo-tutor-dsh/src/index.js', import.meta.url) })
const message = missingPlatformCoreMessage(manifest, found)
const plugin = await import('repo-tutor-dsh')
const tools = new Map()
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
  effect: () => () => {},
  get: () => undefined,
  on: () => () => {},
  inject: () => () => {},
}
plugin.apply(ctx, {})
if (tools.size !== 11) console.log('NO_TOOLS')
else console.log(JSON.stringify({ missing: found.missing ?? 'none', message }))
`,
  )
  const dOut = run(process.execPath, [probeD], { cwd: appD, env: { ...process.env, REPO_TUTOR_CORE: '' } })
  check(
    dOut.out.includes('"missing"') &&
      dOut.out.includes('core-') &&
      dOut.out.includes('--omit=optional') &&
      dOut.out.includes('REPO_TUTOR_CORE') &&
      dOut.out.includes('corePath'),
    'D: the lazy error names the platform package, --omit=optional and the manual escape hatches',
    dOut.out.slice(-500),
  )

  // ── 5. E：--core 覆盖默认平台包 ───────────────────────────────────────
  const presetHome = join(work, 'dsh-home-e')
  const externalCore = join(work, 'my-own-core' + (isWindows ? '.exe' : ''))
  cpSync(corePath, externalCore)
  const installE = run(process.execPath, [join(packageRoot, 'scripts', 'install-preset.mjs'), '--core', externalCore], {
    env: { ...process.env, DSH_HOME: presetHome, REPO_TUTOR_CORE: '' },
  })
  check(installE.status === 0, 'E: install --core succeeds', installE.out.slice(-300))
  const compositionE = readFileSync(join(presetHome, '.agent-presets', 'repo-tutor', 'agent.cordis.yml'), 'utf8')
  check(
    compositionE.includes(externalCore.replaceAll('\\', '/')),
    'E: --core is written as the absolute corePath',
    compositionE.split('\n').filter((line) => line.includes('corePath')).join(' '),
  )
  check(
    !existsSync(join(presetHome, '.agent-presets', 'repo-tutor', 'bin')),
    'E: --core does not copy anything into the preset bin/',
  )

  // ── 6. F：升级 / 降级不留旧二进制 ─────────────────────────────────────
  // 造一个"下一版"包：版本 0.1.1，平台包里的二进制换个名字，多一个 vendored 文件。
  const nextPkg = join(work, 'pkg-next')
  cpSync(packageRoot, nextPkg, { recursive: true, filter: (src) => !src.includes('.git') && !src.includes(`${isWindows ? '\\' : '/'}dist`) })
  const nextManifest = JSON.parse(readFileSync(join(nextPkg, 'package.json'), 'utf8'))
  nextManifest.version = '0.1.1'
  for (const key of Object.keys(nextManifest.optionalDependencies ?? {})) nextManifest.optionalDependencies[key] = '0.1.1'
  writeFileSync(join(nextPkg, 'package.json'), `${JSON.stringify(nextManifest, null, 2)}\n`)
  writeFileSync(join(nextPkg, 'src', 'next-only.mjs'), 'export const marker = 1\n')
  // 下一版的平台包：装进 nextPkg 自己的 node_modules，插件才解析得到；二进制改名成 repo-tutor-core-v2
  const nextBinName = isWindows ? 'repo-tutor-core-v2.exe' : 'repo-tutor-core-v2'
  const nextPlatform = join(nextPkg, 'node_modules', `@repo-tutor`, `core-${suffix}`)
  mkdirSync(join(nextPlatform, 'bin'), { recursive: true })
  cpSync(corePath, join(nextPlatform, 'bin', nextBinName))
  writeFileSync(
    join(nextPlatform, 'package.json'),
    `${JSON.stringify({ ...platformManifest, name: `@repo-tutor/core-${suffix}`, version: '0.1.1', repoTutor: { ...platformManifest.repoTutor, core: `bin/${nextBinName}` } }, null, 2)}\n`,
  )

  const presetHomeF = join(work, 'dsh-home-f')
  const installF1 = run(process.execPath, [join(packageRoot, 'scripts', 'install-preset.mjs')], {
    env: { ...process.env, DSH_HOME: presetHomeF, REPO_TUTOR_CORE: corePath },
  })
  check(installF1.status === 0, 'F: first install (own platform) succeeds', installF1.out.slice(-300))
  const binDir1 = join(presetHomeF, '.agent-presets', 'repo-tutor', 'bin')
  const firstBins = existsSync(binDir1) ? readdirSync(binDir1) : []
  check(firstBins.length === 1, 'F: the first install copies exactly one Core into bin/', firstBins.join(','))

  // 装"下一版"：v0.1.1 的平台包从它自己的 dist 里解析，二进制名字变了
  const installF2 = run(process.execPath, [join(nextPkg, 'scripts', 'install-preset.mjs')], {
    env: { ...process.env, DSH_HOME: presetHomeF, REPO_TUTOR_CORE: '' },
  })
  const presetDirF = join(presetHomeF, '.agent-presets', 'repo-tutor')
  const manifestF = JSON.parse(readFileSync(join(presetDirF, 'installed.json'), 'utf8'))
  const binsF = readdirSync(join(presetDirF, 'bin'))
  check(installF2.status === 0, 'F: upgrading to 0.1.1 succeeds', installF2.out.slice(-400))
  check(manifestF.version === '0.1.1', 'F: the manifest records 0.1.1', manifestF.version)
  check(binsF.length === 1 && binsF[0] === nextBinName, 'F: the old binary was replaced, not piled up', binsF.join(','))
  check(
    existsSync(join(presetDirF, 'plugin', 'src', 'next-only.mjs')),
    'F: the upgrade vendors the new package source set',
  )
  const compositionF = readFileSync(join(presetDirF, 'agent.cordis.yml'), 'utf8')
  check(
    compositionF.includes(`../bin/${nextBinName}`),
    'F: the composition points at the new relative binary path',
    compositionF.split('\n').filter((line) => line.includes('corePath')).join(' '),
  )

  // 降级回当前版本：next-only.mjs 必须消失
  const installF3 = run(process.execPath, [join(packageRoot, 'scripts', 'install-preset.mjs')], {
    env: { ...process.env, DSH_HOME: presetHomeF, REPO_TUTOR_CORE: corePath },
  })
  check(installF3.status === 0, 'F: downgrading back succeeds', installF3.out.slice(-300))
  check(
    !existsSync(join(presetDirF, 'bin', nextBinName)),
    'F: downgrade removes the newer binary (no stale executable left behind)',
    readdirSync(join(presetDirF, 'bin')).join(','),
  )
  check(
    !existsSync(join(presetDirF, 'plugin', 'src', 'next-only.mjs')),
    'F: downgrade removes files the older version does not ship',
  )

  // ── 7. 协议握手：声明版本和 Core 实际版本不一致时拒绝 ──────────────────
  //
  // 不用假可执行文件（Windows 上 spawn .cmd 会 EINVAL），直接把装好的主包
  // manifest 里的 protocolVersion 改成 0.2：真实的 Core 只会报 0.1，握手必须炸。
  const appHandshake = join(work, 'app-handshake')
  mkdirSync(appHandshake, { recursive: true })
  writeFileSync(join(appHandshake, 'package.json'), '{"name":"probe-h","private":true}\n')
  npm(['install', '--no-audit', '--no-fund', '--loglevel=error', platformTgz, mainTgz], { cwd: appHandshake })
  const tamperedManifestPath = join(appHandshake, 'node_modules', 'repo-tutor-dsh', 'package.json')
  const tampered = JSON.parse(readFileSync(tamperedManifestPath, 'utf8'))
  tampered.repoTutor.protocolVersion = '0.2'
  writeFileSync(tamperedManifestPath, `${JSON.stringify(tampered, null, 2)}\n`)

  const probeH = join(appHandshake, 'probe-h.mjs')
  writeFileSync(
    probeH,
    `const plugin = await import('repo-tutor-dsh')
const tools = new Map()
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
  effect: () => () => {},
  get: () => undefined,
  on: () => () => {},
  inject: () => () => {},
}
plugin.apply(ctx, {})
try {
  await tools.get('tutor_status').execute({}, { agent: { session: { header: { cwd: process.cwd() } } } })
  console.log('NO_ERROR')
} catch (error) {
  console.log('ERROR:' + error.message)
}
`,
  )
  const handshake = run(process.execPath, [probeH], {
    cwd: appHandshake,
    env: { ...process.env, REPO_TUTOR_CORE: '' },
  })
  check(
    handshake.out.includes('protocol mismatch') &&
      handshake.out.includes('0.2') &&
      handshake.out.includes('0.1'),
    'handshake: a Core whose protocol does not match the package is refused with a clear message',
    handshake.out.slice(-500),
  )

  // ── 8. I：真实 preset 目录不受影响 ────────────────────────────────────
  check(fingerprint(realPreset) === realFingerprint, 'I: the real $DSH_HOME preset was not touched by these tests')
} catch (error) {
  check(false, `platform test crashed: ${error.message}`)
} finally {
  rmSync(join(packageRoot, 'dist'), { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'all platform-core checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
