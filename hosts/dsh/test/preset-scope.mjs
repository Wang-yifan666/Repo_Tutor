// Preset 作用域的永久回归测试：工具可见性、Preset/Bundle 隔离、Core 运行时错误。
//
// 只装 Tutor Preset，**完全不装 Repo Tutor Bundle**，在隔离 DSH_HOME 里起真实 DSH 进程，
// 用与 UI 相同的 roster API（standingKeyFor / mount / composedPreset / tools.execute）观测。
//
// 三条容易踩的坑，这个测试专门钉住：
//   1. tools.get(name) 不传 scope 是**全局视图**，不能用它判断 agent 能不能看到工具；
//   2. agents.create() 不会自己组合 preset —— 必须显式 agentPresets.mount(agent.ctx, id)；
//   3. standingKeyFor === mounted 也不代表工具可用，唯一的判定是 tools.execute({ agent })。
//
// 用法：DSH_HARNESS=<dsh checkout> node hosts/dsh/test/preset-scope.mjs

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const isWindows = process.platform === 'win32'
const harness = process.env.DSH_HARNESS
if (harness === undefined || harness === '') {
  console.log('SKIPPED: DSH_HARNESS is not set')
  process.exit(0)
}
const cliEntry = join(harness, 'apps', 'cli', 'src', 'bin.ts')
const tsxEntry = join(harness, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
const tsconfig = join(harness, 'tsconfig.json')
// 这个用例验的是 $DSH_HOME/.agent-presets 那套目录式 preset；DSH 0.2 起没人读了，
// 那边换成 hosts/dsh/test/preset-dsh02.mjs。
{
  const version = JSON.parse(readFileSync(join(harness, 'package.json'), 'utf8')).version
  if (!/^0\.1\./.test(version)) {
    console.log(`SKIPPED: directory presets belong to dsh 0.1.x, this checkout is ${version} (see preset-dsh02.mjs)`)
    process.exit(0)
  }
}
const exeName = isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core'
const corePath = process.env.REPO_TUTOR_CORE || join(repoRoot, 'build', isWindows ? 'dev-mingw' : 'dev', 'apps', 'repo-tutor-core', exeName)
for (const required of [cliEntry, tsxEntry, tsconfig, corePath]) {
  if (!existsSync(required)) {
    console.log(`SKIPPED: missing ${required}`)
    process.exit(0)
  }
}

let failures = 0
function check(condition, message, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}${condition || detail === undefined ? '' : `\n      ${detail}`}`)
  if (!condition) failures += 1
}

const work = mkdtempSync(join(tmpdir(), 'repo-tutor-scope-'))
const dshHome = join(work, 'home')
const fixture = join(work, 'repo')
mkdirSync(join(fixture, 'src'), { recursive: true })
writeFileSync(join(fixture, 'src', 'main.cpp'), 'int add(int a, int b) { return a + b; }\n')
for (const name of ['.credentials.yaml', 'settings.yaml']) {
  const source = join(process.env.DSH_HOME_REAL ?? join(homedir(), '.dsh'), name)
  if (existsSync(source)) {
    mkdirSync(dshHome, { recursive: true })
    spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    writeFileSync(join(dshHome, name), readFileSync(source))
  }
}

const probePath = join(work, 'probe.mjs')
const outPath = join(work, 'out.json')
writeFileSync(
  probePath,
  `import { writeFileSync } from 'node:fs'
export const name = 'rt-scope-probe'
export const inject = ['agentPresets', 'agents', 'tools']
export function apply(ctx) {
  setTimeout(async () => {
    const out = {}
    const signal = new AbortController().signal
    let n = 0
    const run = async (agent, tool, args) => {
      const result = await ctx.tools.execute({ callId: 'c' + ++n, name: tool, arguments: args ?? {}, agent, signal })
      return result.isError ? 'ERROR:' + String(result.error?.message ?? '').slice(0, 140) : 'OK'
    }
    const make = async (preset) => {
      const agent = (await ctx.agents.create({ sessionId: preset + '-' + Date.now(), meta: { cwd: process.env.RT_CWD, agentPreset: preset }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' } })).agent
      await ctx.agentPresets.mount(agent.ctx, preset)
      return agent
    }
    try {
      const standingKey = await ctx.agentPresets.standingKeyFor('repo-tutor')
      out.getGlobal = ctx.tools.get('tutor_status') === undefined ? 'absent' : 'present'
      out.getStanding = ctx.tools.get('tutor_status', standingKey) === undefined ? 'absent' : 'present'
      const tutor = await make('repo-tutor')
      out.tutorComposed = ctx.agentPresets.composedPreset(tutor.ctx) ?? null
      out.tutorGetGlobalView = tutor.ctx.tools.get('tutor_status') === undefined ? 'absent' : 'present'
      out.tutorExecute = await run(tutor, 'tutor_status')
      out.tutorReadExecute = await run(tutor, 'read', { file_path: 'src/main.cpp' })
      const std = await make('standard')
      out.stdComposed = ctx.agentPresets.composedPreset(std.ctx) ?? null
      out.stdTutorExecute = await run(std, 'tutor_status')
      out.stdReadExecute = await run(std, 'read', { file_path: 'src/main.cpp' })
      out.globalLeak = ctx.tools.get('tutor_status') === undefined ? 'none' : 'LEAKED'
    } catch (error) {
      out.error = String(error?.stack ?? error).slice(0, 400)
    }
    writeFileSync(process.env.RT_OUT, JSON.stringify(out, null, 2))
  }, 600)
}
`,
)

const overlay = join(work, 'overlay.yml')
writeFileSync(overlay, `- insert:\n    - id: rt-scope-probe\n      name: '${probePath.replaceAll('\\', '/')}'\n`)

let server
try {
  // 只装 preset，不装 bundle
  const installed = spawnSync(
    process.execPath,
    [join(packageRoot, 'scripts', 'install-preset.mjs'), '--core', corePath],
    { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome, REPO_TUTOR_CORE: '' } },
  )
  check(installed.status === 0, 'the Tutor preset installs into the isolated home', (installed.stderr ?? '').slice(-300))
  check(
    !existsSync(join(dshHome, 'profiles', 'web', 'node_modules', 'repo-tutor-dsh')),
    'no Repo Tutor Bundle is installed (preset-only environment)',
  )

  server = spawn(
    process.execPath,
    ['--import', `file:///${tsxEntry.replaceAll('\\', '/')}`, cliEntry, '--profile', 'web', '--patch', overlay, '--port', '3088', '--no-open'],
    {
      cwd: fixture,
      env: { ...process.env, DSH_HOME: dshHome, TSX_TSCONFIG_PATH: tsconfig, RT_OUT: outPath, RT_CWD: fixture, REPO_TUTOR_CORE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  server.stdout.on('data', (c) => { log += c.toString() })
  server.stderr.on('data', (c) => { log += c.toString() })

  const deadline = Date.now() + 120000
  let out
  while (Date.now() < deadline) {
    if (existsSync(outPath)) {
      try { out = JSON.parse(readFileSync(outPath, 'utf8')); break } catch { /* 写入中 */ }
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  check(out !== undefined, 'the scope probe answered', log.slice(-500))
  if (out !== undefined) {
    check(out.error === undefined, 'the probe hit no exception', out.error)
    check(out.getGlobal === 'absent', 'the global tool view does NOT contain tutor_status (no host-wide registration)')
    check(out.getStanding === 'present', 'the standing scope DOES contain tutor_status')
    check(out.tutorComposed === 'repo-tutor', 'the Tutor agent reports composedPreset = repo-tutor', String(out.tutorComposed))
    check(
      out.tutorGetGlobalView === 'absent',
      "tools.get(name) without a scope reads the GLOBAL view even on agent.ctx (documented trap)",
    )
    check(out.tutorExecute === 'OK', 'tools.execute({ agent }) runs tutor_status for the Tutor agent', out.tutorExecute)
    check(
      out.tutorReadExecute.startsWith('ERROR:'),
      'the Tutor agent cannot call read (evidence firewall / preset isolation)',
      out.tutorReadExecute,
    )
    check(out.stdComposed === 'standard', 'the Standard agent reports composedPreset = standard', String(out.stdComposed))
    check(
      out.stdTutorExecute.startsWith('ERROR:'),
      'the Standard agent cannot see Tutor tools (preset isolation)',
      out.stdTutorExecute,
    )
    check(out.stdReadExecute === 'OK', 'the Standard agent still has its own read tool', out.stdReadExecute)
    check(out.globalLeak === 'none', 'no tutor tool leaked into the global registry')
  }
} catch (error) {
  check(false, `preset-scope test crashed: ${error.message}`)
} finally {
  if (server !== undefined) {
    server.kill()
    await new Promise((r) => setTimeout(r, 1500))
  }
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'all preset-scope checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
