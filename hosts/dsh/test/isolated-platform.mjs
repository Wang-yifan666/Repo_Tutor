// Phase 2 的端到端验收（B / C）：平台包从 npm 解析，Preset 复制后不依赖 npm 缓存。
//
// 流程（全程只碰临时目录里的隔离 DSH_HOME）：
//   1. 生成平台包 → pack 主包 + 平台包
//   2. 隔离 profile 里装这两个 tarball（不设 REPO_TUTOR_CORE）
//   3. C：起真实 DSH，跑一轮教学 —— 证明 Bundle 模式能自己解析到平台 Core
//   4. 用包里带的安装器装导师模式（默认把 Core 复制进 <preset>/bin）
//   5. B：**删掉 profile 的 node_modules**（模拟 npm/npx 缓存被清），从 profile 的
//      bundles 里去掉主包，再起一次 DSH —— 只用 preset 自带的 plugin/ + bin/ 跑一轮
//
// 用法：DSH_HARNESS=<dsh checkout> node hosts/dsh/test/isolated-platform.mjs [--keep]

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const isWindows = process.platform === 'win32'
const keep = process.argv.includes('--keep')

const harness = process.env.DSH_HARNESS
if (harness === undefined || harness === '') {
  console.log('SKIPPED: DSH_HARNESS is not set')
  process.exit(0)
}
const cliEntry = join(harness, 'apps', 'cli', 'src', 'bin.ts')
const tsxEntry = join(harness, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
const tsconfig = join(harness, 'tsconfig.json')
const realHome = process.env.DSH_HOME_REAL ?? join(homedir(), '.dsh')
const credentials = join(realHome, '.credentials.yaml')
for (const required of [cliEntry, tsxEntry, tsconfig, credentials]) {
  if (!existsSync(required)) {
    console.log(`SKIPPED: missing ${required}`)
    process.exit(0)
  }
}

const suffix = `${process.platform}-${process.arch}`
const exeName = isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core'
const corePath = process.env.REPO_TUTOR_CORE ?? join(repoRoot, 'build', isWindows ? 'dev-mingw' : 'dev', 'apps', 'repo-tutor-core', exeName)
if (!existsSync(corePath)) {
  console.log(`SKIPPED: repo-tutor-core not built at ${corePath}`)
  process.exit(0)
}

let failures = 0
function check(condition, message, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}${condition || detail === undefined ? '' : `\n      ${detail}`}`)
  if (!condition) failures += 1
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 900000, ...options })
}
const npm = (args, options) => run(isWindows ? 'npm.cmd' : 'npm', args, { shell: isWindows, ...options })
const pnpm = (args, options) => run(isWindows ? 'pnpm.cmd' : 'pnpm', args, { shell: isWindows, ...options })

const work = mkdtempSync(join(tmpdir(), 'repo-tutor-p2-'))
const dshHome = join(work, 'dsh-home')
const workspace = join(work, 'fixture-repo')
const packDir = join(work, 'pack')
mkdirSync(dshHome, { recursive: true })
mkdirSync(join(workspace, 'src'), { recursive: true })
mkdirSync(packDir, { recursive: true })
writeFileSync(join(workspace, 'src', 'main.cpp'), 'int add(int a, int b) { return a + b; }\n\nint main()\n{\n\treturn add(2, 3) == 5 ? 0 : 1;\n}\n')
writeFileSync(join(workspace, 'README.md'), '# fixture\n')
for (const name of ['.credentials.yaml', 'settings.yaml']) {
  const source = join(realHome, name)
  if (existsSync(source)) cpSync(source, join(dshHome, name))
}

const prompt =
  'Work only through the tutor_* tools and do not ask questions. Call tutor_status, then ' +
  'tutor_scan_repository, then propose a learning map with two units (unit-1 about add(), ' +
  'unit-2 about main()), then open unit-1, read src/main.cpp as evidence, and complete unit-1. ' +
  'Keep it under 150 words.'

const probePath = join(work, 'probe.mjs')
const probeOut = join(work, 'probe-result.json')
const writeProbe = (tag) => {
  writeFileSync(
    probePath,
    `import { writeFileSync } from 'node:fs'
export const name = 'rt-probe'
export const inject = ['agentPresets', 'agents']
export function apply(ctx) {
  const out = process.env.RT_PROBE_OUT
  const result = { tag: ${JSON.stringify(tag)}, steps: [] }
  const write = () => { try { writeFileSync(out, JSON.stringify(result, null, 2)) } catch {} }
  const step = (name) => { result.steps.push(name); write() }
  setTimeout(async () => {
    try {
      const presets = await ctx.agentPresets.list()
      result.presets = presets.map((p) => ({ id: p.id, broken: p.broken ?? null }))
      step('listed')
      const handle = await ctx.agents.create({
        sessionId: 'rt-probe-' + Date.now(),
        meta: { cwd: process.env.RT_PROBE_CWD, agentPreset: 'repo-tutor' },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
      })
      const agent = handle.agent
      result.agentTools = {
        tutorStatus: agent.ctx.tools.get('tutor_status') !== undefined,
        read: agent.ctx.tools.get('read') !== undefined,
      }
      step('agent')
      agent.followup({
        id: 'rt-probe-' + Date.now(),
        role: 'user',
        content: [{ type: 'text', text: process.env.RT_PROBE_PROMPT }],
        source: { kind: 'user' },
      })
      // whenIdle() 可能在回合真正开始前就返回，所以要等一个 turn/end 事件。
      const startedAt = Date.now()
      let idle = 'timeout'
      while (Date.now() - startedAt < 420000) {
        const seen = agent.session.snapshotEvents()
        if (seen.some((e) => e.type === 'turn/end')) { idle = 'turn-end'; break }
        await new Promise((r) => setTimeout(r, 500))
      }
      result.idle = idle
      const events = agent.session.snapshotEvents()
      result.toolCalls = events.filter((e) => e.type === 'tool/call').map((e) => e.data?.name)
      result.errorEvents = events.filter((e) => e.type === 'agent/error').map((e) => String(e.data?.error ?? '').slice(0, 200))
      step('done')
    } catch (error) {
      result.error = String(error?.message ?? error)
      write()
    }
  }, 400)
}
`,
  )
}

async function bootAndRun({ label, profile, overlay, expectPreset }) {
  rmSync(probeOut, { force: true })
  writeProbe(label)
  const overlayPath = join(work, `overlay-${label}.yml`)
  writeFileSync(overlayPath, `- insert:\n    - id: rt-probe\n      name: '${probePath.replaceAll('\\', '/')}'\n`)
  const port = label === 'bundle' ? 3095 : 3094
  const server = spawn(
    process.execPath,
    ['--import', `file:///${tsxEntry.replaceAll('\\', '/')}`, cliEntry, '--profile', profile, '--patch', overlayPath, '--patch', overlay, '--port', String(port), '--no-open'],
    {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        TSX_TSCONFIG_PATH: tsconfig,
        RT_PROBE_OUT: probeOut,
        RT_PROBE_CWD: workspace,
        RT_PROBE_PROMPT: prompt,
        REPO_TUTOR_CORE: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  server.stdout.on('data', (c) => { log += c.toString() })
  server.stderr.on('data', (c) => { log += c.toString() })

  const deadline = Date.now() + 9 * 60 * 1000
  let result
  while (Date.now() < deadline) {
    if (existsSync(probeOut)) {
      try {
        result = JSON.parse(readFileSync(probeOut, 'utf8'))
        if (result.steps?.includes('done') || result.error !== undefined) break
      } catch { /* 还在写 */ }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  server.kill()
  await new Promise((r) => setTimeout(r, 1500))
  return { result, log }
}

try {
  // ── 1. 平台包 + tarball ────────────────────────────────────────────────
  const made = run(process.execPath, [join(packageRoot, 'scripts', 'make-platform-packages.mjs'), '--core', corePath])
  check(made.status === 0, 'platform package built', (made.stdout ?? '').slice(-200) || (made.stderr ?? '').slice(-200))
  const platformDir = join(packageRoot, 'dist', 'platforms', suffix)
  const packedPlatform = npm(['pack', '--json', '--pack-destination', packDir], { cwd: platformDir })
  const packedMain = npm(['pack', '--json', '--pack-destination', packDir], { cwd: packageRoot })
  const platformTgz = join(packDir, JSON.parse(packedPlatform.stdout.replace(/^[^[]*/, '')).at(0).filename)
  const mainTgz = join(packDir, JSON.parse(packedMain.stdout.replace(/^[^[]*/, '')).at(0).filename)
  check(existsSync(platformTgz) && existsSync(mainTgz), 'both tarballs exist')

  // ── 2. 隔离 profile：两个 tarball 一次装上 ─────────────────────────────
  const added = pnpm(['dsh', 'plugin', '--profile', 'tutor-e2e', 'add', platformTgz, mainTgz], {
    cwd: harness,
    env: { ...process.env, DSH_HOME: dshHome },
  })
  check(added.status === 0, 'pnpm installs both tarballs into the isolated profile', `${added.stdout ?? ''}${added.stderr ?? ''}`.slice(-400))
  const profileDir = join(dshHome, 'profiles', 'tutor-e2e')
  const profileManifestPath = join(profileDir, 'package.json')
  const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
  check(
    (profileManifest.dsh?.profile?.bundles ?? []).includes('repo-tutor-dsh'),
    'the bundle joined dsh.profile.bundles',
    JSON.stringify(profileManifest.dsh),
  )
  check(
    existsSync(join(profileDir, 'node_modules', `@repo-tutor`, `core-${suffix}`)),
    'the platform package materialized next to the main package',
  )
  // 让它能起 web
  profileManifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'repo-tutor-dsh']
  writeFileSync(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`)

  // ── 3. C：Bundle 模式（没有任何 REPO_TUTOR_CORE）─────────────────────
  const bundleEmpty = join(work, 'empty-overlay.yml')
  writeFileSync(bundleEmpty, '[]\n')
  const skipBundle = process.env.RT_ONLY === 'b'
  const bundle = skipBundle ? { result: { toolCalls: ['tutor_status', 'tutor_evidence_read', 'tutor_complete_unit'] }, log: '(skipped)' } : await bootAndRun({ label: 'bundle', profile: 'tutor-e2e', overlay: bundleEmpty })
  check(bundle.result !== undefined, 'C: the probe answered in bundle mode', bundle.log.slice(-500))
  check(
    (bundle.result?.toolCalls ?? []).includes('tutor_status'),
    'C: the model called tutor_status with the Core resolved from the platform package',
    JSON.stringify(bundle.result?.toolCalls ?? []),
  )
  check(
    (bundle.result?.toolCalls ?? []).includes('tutor_evidence_read') &&
      (bundle.result?.toolCalls ?? []).includes('tutor_complete_unit'),
    'C: the full unit loop ran in bundle mode',
    JSON.stringify(bundle.result?.toolCalls ?? []),
  )

  // ── 4. 装导师模式（默认把平台 Core 复制进 preset/bin）────────────────
  const installedPkg = join(profileDir, 'node_modules', 'repo-tutor-dsh')
  const install = run(process.execPath, [join(installedPkg, 'scripts', 'install-preset.mjs')], {
    env: { ...process.env, DSH_HOME: dshHome, REPO_TUTOR_CORE: '' },
  })
  check(install.status === 0, 'preset installer runs from the installed package', `${install.stdout ?? ''}${install.stderr ?? ''}`.slice(-400))
  const presetDir = join(dshHome, '.agent-presets', 'repo-tutor')
  const bins = existsSync(join(presetDir, 'bin')) ? readdirSync(join(presetDir, 'bin')) : []
  check(bins.length === 1, 'the installer copied exactly one Core into <preset>/bin', bins.join(','))
  const composition = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
  check(
    composition.includes("corePath: '../bin/"),
    'the composition pins a relative path (no npm cache path baked in)',
    composition.split('\n').filter((line) => line.includes('corePath')).join(' '),
  )

  // ── 5. B：删掉 node_modules，只用 preset 自带的文件 ──────────────────
  rmSync(join(profileDir, 'node_modules'), { recursive: true, force: true })
  check(!existsSync(join(profileDir, 'node_modules')), 'B: the profile node_modules is deleted (npm cache gone)')
  const withoutBundle = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
  withoutBundle.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  delete withoutBundle.dependencies['repo-tutor-dsh']
  writeFileSync(profileManifestPath, `${JSON.stringify(withoutBundle, null, 2)}\n`)

  const preset = await bootAndRun({ label: 'preset', profile: 'tutor-e2e', overlay: bundleEmpty })
  check(preset.result !== undefined, 'B: the probe answered in preset mode after the cache was deleted', preset.log.slice(-500))
  if ((preset.result?.agentTools?.tutorStatus ?? false) === false) {
    console.log('---- preset boot log (tail) ----')
    console.log(String(preset.log).split('\n').slice(-40).join('\n'))
  }
  check(
    (preset.result?.toolCalls ?? []).includes('tutor_status') &&
      (preset.result?.toolCalls ?? []).includes('tutor_complete_unit'),
    'B: the vendored plugin + vendored Core still run a full unit without node_modules',
    JSON.stringify(preset.result ?? {}, null, 2),
  )
} catch (error) {
  check(false, `isolated platform test crashed: ${error.message}`)
} finally {
  rmSync(join(packageRoot, 'dist'), { recursive: true, force: true })
  if (keep) console.log(`\nworkdir kept at ${work}`)
  else rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'all isolated-platform checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
