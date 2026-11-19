// Negative test：故意破坏 preset 的插件入口，Tutor 工具必须不可调用，测试必须红；
// 修好路径后必须重新变绿。
//
// 它验证的是"测试本身有效"，而不是产品行为——如果破坏后还绿，说明之前的通过是假的。
//
// 用法：DSH_HARNESS=<dsh checkout> node hosts/dsh/test/preset-negative.mjs

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const corePath =
  process.env.REPO_TUTOR_CORE ||
  join(repoRoot, 'build', isWindows ? 'dev-mingw' : 'dev', 'apps', 'repo-tutor-core', isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core')
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

const work = mkdtempSync(join(tmpdir(), 'repo-tutor-negative-'))
const fixture = join(work, 'repo')
mkdirSync(join(fixture, 'src'), { recursive: true })
writeFileSync(join(fixture, 'src', 'main.cpp'), 'int add(int a, int b) { return a + b; }\n')

const probePath = join(work, 'probe.mjs')
writeFileSync(
  probePath,
  `import { writeFileSync } from 'node:fs'
export const name = 'rt-neg-probe'
export const inject = ['agentPresets', 'agents', 'tools']
export function apply(ctx) {
  setTimeout(async () => {
    const out = {}
    try {
      const agent = (await ctx.agents.create({ sessionId: 'neg-' + Date.now(), meta: { cwd: process.env.RT_CWD, agentPreset: 'repo-tutor' }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' } })).agent
      await ctx.agentPresets.mount(agent.ctx, 'repo-tutor')
      const result = await ctx.tools.execute({ callId: 'n1', name: 'tutor_status', arguments: {}, agent, signal: new AbortController().signal })
      out.execute = result.isError ? 'ERROR:' + String(result.error?.message ?? '').slice(0, 120) : 'OK'
    } catch (error) {
      out.mountOrCreate = String(error?.message ?? error).slice(0, 200)
    }
    writeFileSync(process.env.RT_OUT, JSON.stringify(out, null, 2))
  }, 600)
}
`,
)
const overlay = join(work, 'overlay.yml')
writeFileSync(overlay, `- insert:\n    - id: rt-neg-probe\n      name: '${probePath.replaceAll('\\', '/')}'\n`)

/** 起一个隔离实例，返回 probe 输出；用于破坏 / 修复两轮。 */
async function observe(label) {
  const dshHome = join(work, `home-${label}`)
  const outPath = join(work, `out-${label}.json`)
  const install = spawnSync(process.execPath, [join(packageRoot, 'scripts', 'install-preset.mjs'), '--core', corePath], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: dshHome, REPO_TUTOR_CORE: '' },
  })
  if (install.status !== 0) return { installFailed: (install.stderr ?? '').slice(-300) }

  const compositionPath = join(dshHome, '.agent-presets', 'repo-tutor', 'agent.cordis.yml')
  const good = readFileSync(compositionPath, 'utf8')

  if (label === 'broken') {
    // 只破坏插件入口这一行：指向一个不存在的文件
    writeFileSync(compositionPath, good.replace("name: './plugin/src/index.js'", "name: './plugin/src/does-not-exist.js'"))
  }

  const server = spawn(
    process.execPath,
    ['--import', `file:///${tsxEntry.replaceAll('\\', '/')}`, cliEntry, '--profile', 'web', '--patch', overlay, '--port', label === 'broken' ? '3087' : '3086', '--no-open'],
    {
      cwd: fixture,
      env: { ...process.env, DSH_HOME: dshHome, TSX_TSCONFIG_PATH: tsconfig, RT_OUT: outPath, RT_CWD: fixture, REPO_TUTOR_CORE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  server.stdout.on('data', (c) => { log += c.toString() })
  server.stderr.on('data', (c) => { log += c.toString() })

  const deadline = Date.now() + 90000
  let out
  while (Date.now() < deadline) {
    if (existsSync(outPath)) {
      try { out = JSON.parse(readFileSync(outPath, 'utf8')); break } catch { /* 写入中 */ }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  server.kill()
  await new Promise((r) => setTimeout(r, 1200))

  // 修复：把 composition 还原
  if (label === 'broken') writeFileSync(compositionPath, good)
  return { out, log }
}

try {
  const broken = await observe('broken')
  const brokenUnusable =
    broken.out !== undefined &&
    (broken.out.execute?.startsWith('ERROR:') === true || broken.out.mountOrCreate !== undefined)
  check(
    brokenUnusable,
    'NEGATIVE: with a broken plugin entry the Tutor tool is NOT callable (so the green runs mean something)',
    JSON.stringify(broken.out ?? broken.installFailed ?? broken.log.slice(-300)),
  )

  const fixed = await observe('fixed')
  check(fixed.out?.execute === 'OK', 'AFTER FIX: restoring the entry makes tutor_status callable again', JSON.stringify(fixed.out ?? {}))
} catch (error) {
  check(false, `negative test crashed: ${error.message}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'negative-test checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
