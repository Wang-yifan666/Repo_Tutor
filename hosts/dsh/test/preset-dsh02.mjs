// DSH 0.2.x 的 preset 验收：bundle 里那条 `@deepseek-ai/dsh-agent-preset` 声明能不能
// 真的变成模式列表里的「导师模式」，挂上去之后能不能跑完一轮教学。
//
// 和 isolated-platform.mjs 的分工：那边验 0.1.x 的目录式 preset（0.2 已经没人读了），
// 这边验 bundle 声明式的那条路。全程只碰临时 DSH_HOME，不碰真实的。
//
// 用法：DSH_HARNESS=<dsh checkout> node hosts/dsh/test/preset-dsh02.mjs [--keep]
// 退出码：0 通过，1 有断言失败，2 用法错误。

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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

// 这条验收只对 bundle 声明式 preset 有意义；0.1.x 上应当直接跳过。
const harnessVersion = JSON.parse(readFileSync(join(harness, 'package.json'), 'utf8')).version
if (!/^0\.[2-9]\./.test(harnessVersion)) {
  console.log(`SKIPPED: this test covers the bundle-declared preset mechanism, dsh is ${harnessVersion}`)
  process.exit(0)
}

let failures = 0
function check(condition, message, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}${condition || detail === undefined ? '' : `\n      ${detail}`}`)
  if (!condition) failures += 1
}
function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 600000, ...options })
}
const npm = (args, options) => run(isWindows ? 'npm.cmd' : 'npm', args, { shell: isWindows, ...options })

// ── 1. 打包：主包 + 当前平台的 Core 包 ────────────────────────────────────

const suffix = `${process.platform}-${process.arch}`
const corePath = process.env.REPO_TUTOR_CORE
  || join(packageRoot, '..', '..', 'build', isWindows ? 'rc-win32' : 'rc-linux', 'apps', 'repo-tutor-core', isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core')
if (!existsSync(corePath)) {
  console.log(`SKIPPED: repo-tutor-core not built at ${corePath}`)
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'repo-tutor-dsh02-'))
const dshHome = join(work, 'dsh-home')
const packDir = join(work, 'pack')
const workspace = join(work, 'fixture-repo')
mkdirSync(packDir, { recursive: true })
mkdirSync(join(workspace, 'src'), { recursive: true })
writeFileSync(join(workspace, 'src', 'main.cpp'), 'int add(int a, int b) { return a + b; }\n\nint main()\n{\n\treturn add(2, 3) == 5 ? 0 : 1;\n}\n')
for (const name of ['.credentials.yaml', 'settings.yaml']) {
  const source = join(realHome, name)
  if (existsSync(source)) cpSync(source, join(dshHome, name))
}

function pack(label, cwd) {
  const result = npm(['pack', '--json', '--pack-destination', packDir], { cwd })
  const output = String(result.stdout ?? '').trim()
  if (result.status !== 0 || output === '') {
    check(false, `npm pack ${label}`, `${result.error ?? ''} ${(result.stderr ?? '').toString().slice(0, 300)}`)
    return undefined
  }
  const [info] = JSON.parse(output.replace(/^[^[]*/, ''))
  const tarball = resolve(packDir, info.filename)
  check(existsSync(tarball), `npm pack ${label} wrote ${info.filename}`)
  return tarball
}

const made = run(process.execPath, [join(packageRoot, 'scripts', 'make-platform-packages.mjs'), '--core', corePath])
check(made.status === 0, 'platform package built', `${made.stdout ?? ''}${made.stderr ?? ''}`.slice(-300))
const platformTgz = pack('platform', join(packageRoot, 'dist', 'platforms', suffix))
const mainTgz = pack('main', packageRoot)

const probePath = join(work, 'probe.mjs')
const probeOut = join(work, 'probe-result.json')

// ── 2. 隔离 profile：两个 tarball 一次装上 ────────────────────────────────

const dshEnv = { ...process.env, DSH_HOME: dshHome, TSX_TSCONFIG_PATH: tsconfig }
function dsh(args) {
  return run(process.execPath, ['--import', `file:///${tsxEntry.replaceAll('\\', '/')}`, cliEntry, ...args], {
    cwd: harness,
    env: dshEnv,
  })
}

if (platformTgz !== undefined && mainTgz !== undefined) {
  const added = dsh(['plugin', '--profile', 'rt02', 'add', platformTgz, mainTgz])
  check(added.status === 0, 'pnpm installs both tarballs into the isolated profile', `${added.stdout ?? ''}${added.stderr ?? ''}`.slice(-600))

  const profileDir = join(dshHome, 'profiles', 'rt02')
  const profileManifestPath = join(profileDir, 'package.json')
  const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
  check(
    (profileManifest.dsh?.profile?.bundles ?? []).includes('repo-tutor-dsh'),
    'the bundle joined dsh.profile.bundles',
    JSON.stringify(profileManifest.dsh),
  )
  // web app 叠加在 base 之上，Repo Tutor 作为最后一层。
  profileManifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'repo-tutor-dsh']
  writeFileSync(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`)

  // 组合树里应当出现 preset 声明行 —— 不启动也能验的一半。
  const dumped = dsh(['--profile', 'rt02', '--dump-config'])
  const tree = `${dumped.stdout ?? ''}${dumped.stderr ?? ''}`
  check(tree.includes('preset-repo-tutor'), 'the composed tree holds the preset-repo-tutor row')
  check(tree.includes("name: '@deepseek-ai/dsh-agent-preset'"), 'the row is a dsh-agent-preset declaration')

  // ── 3. 真起 DSH，探针挂在 preset 上跑一轮 ──────────────────────────────

  writeFileSync(probePath, `import { writeFileSync } from 'node:fs'
export const name = 'rt-probe'
export const inject = ['agentPresets', 'agents']
export function apply(ctx) {
  const out = process.env.RT_PROBE_OUT
  const result = { steps: [] }
  const write = () => { try { writeFileSync(out, JSON.stringify(result, null, 2)) } catch {} }
  const step = (name) => { result.steps.push(name); write() }
  setTimeout(async () => {
    try {
      const presets = await ctx.agentPresets.list()
      result.presets = presets.map((p) => ({ id: p.id, name: p.name ?? null, broken: p.broken ?? null }))
      step('listed')
      const handle = await ctx.agents.create({
        sessionId: 'rt-probe-' + Date.now(),
        meta: { cwd: process.env.RT_PROBE_CWD, agentPreset: 'repo-tutor' },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'repo-tutor') },
      })
      const agent = handle.agent
      if (ctx.agentPresets.composedPreset(agent.ctx) === undefined) {
        await ctx.agentPresets.mount(agent.ctx, 'repo-tutor')
      }
      result.composedPreset = ctx.agentPresets.composedPreset(agent.ctx) ?? null
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
      const startedAt = Date.now()
      let idle = 'timeout'
      while (Date.now() - startedAt < 420000) {
        const seen = agent.session.snapshotEvents()
        if (seen.some((e) => e.type === 'turn/end')) { idle = 'turn-end'; break }
        await new Promise((r) => setTimeout(r, 500))
      }
      result.idle = idle
      const events = agent.session.snapshotEvents()
      result.eventTypes = events.map((e) => e.type)
      result.turnEnd = events.filter((e) => e.type === 'turn/end').map((e) => e.data ?? null)
      result.toolCalls = events.filter((e) => e.type === 'tool/call').map((e) => e.data?.name)
      // 模型没调工具时要能看出它到底说了什么，否则只能猜。
      result.assistant = events
        .filter((e) => e.type === 'assistant/message')
        .map((e) => JSON.stringify(e.data ?? null).slice(0, 600))
      result.errorEvents = events.filter((e) => e.type === 'agent/error').map((e) => String(e.data?.error ?? '').slice(0, 200))
      step('done')
    } catch (error) {
      result.error = String(error?.message ?? error)
      write()
    }
  }, 400)
}
`)

  const overlayPath = join(work, 'overlay.yml')
  writeFileSync(overlayPath, `- insert:\n    - id: rt-probe\n      name: '${probePath.replaceAll('\\', '/')}'\n`)

  const server = spawn(
    process.execPath,
    ['--import', `file:///${tsxEntry.replaceAll('\\', '/')}`, cliEntry, '--profile', 'rt02', '--patch', overlayPath, '--port', '3097', '--no-open'],
    {
      cwd: workspace,
      env: { ...dshEnv, RT_PROBE_OUT: probeOut, RT_PROBE_CWD: workspace, RT_PROBE_PROMPT:
        'Work only through the tutor_* tools and do not ask questions. Call tutor_status, then ' +
        'tutor_scan_repository, then propose a learning map with two units (unit-1 about add(), ' +
        'unit-2 about main()), then open unit-1, read src/main.cpp as evidence, and complete unit-1. ' +
        'Keep it under 150 words.' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  server.stdout.on('data', (chunk) => { log += chunk.toString() })
  server.stderr.on('data', (chunk) => { log += chunk.toString() })

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

  const detail = () => JSON.stringify(result ?? {}, null, 2)
  check(result !== undefined, 'the probe answered inside the isolated DSH', log.slice(-600))
  const presetIds = (result?.presets ?? []).map((entry) => entry.id)
  check(presetIds.includes('repo-tutor'), 'the roster lists repo-tutor as a preset', JSON.stringify(presetIds))
  check(
    (result?.presets ?? []).every((entry) => entry.broken === null),
    'no preset on the roster is broken',
    JSON.stringify(result?.presets ?? []),
  )
  check(result?.composedPreset === 'repo-tutor', 'the agent composed the repo-tutor preset', detail())
  check(result?.agentTools?.tutorStatus === true, 'the preset agent has the tutor_* tools', detail())
  check(result?.agentTools?.read === false, 'the preset agent still has no bypass read tool', detail())
  const expected = ['tutor_status', 'tutor_scan_repository', 'tutor_propose_learning_map', 'tutor_open_unit', 'tutor_evidence_read', 'tutor_complete_unit']
  const seenCalls = result?.toolCalls ?? []
  console.log('      tool sequence: ' + JSON.stringify(seenCalls))
  console.log('      session end  : ' + String(result?.idle))
  check(expected.every((name) => seenCalls.includes(name)), 'the model called all six tutor tools through the declared preset', detail())
  check((result?.errorEvents ?? []).length === 0, 'no agent error was raised', detail())
}

if (keep) console.log(`\nworkdir kept at ${work}`)
else rmSync(work, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'all dsh-0.2 preset checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
