// PoC：能不能让 Bundle 自己声明一个 preset root，而不是把文件复制进 $DSH_HOME？
//
// 它验证两条事实（都用真实 DSH 进程，不改任何真实配置）：
//   A. `agent-presets` 行的 `roots` 可以从 Bundle Patch 里加 —— 就是"部署级 preset 根"
//   B. preset 里的行怎么解析：
//        - `../src/index.js`（相对 preset 目录）→ 能挂载
//        - `repo-tutor-dsh`（包名）           → 解析不了，roster 报 broken
//      因为包名是按**已安装的 harness** 解析的，而包装在 profile 的 node_modules 里。
//
// 结论用来指导第二阶段：复制方案暂时不能丢，除非上游支持 bundle 自带 preset root。
//
// 用法：DSH_HARNESS=<dsh checkout> node hosts/dsh/test/preset-root-poc.mjs [--keep]

import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const isWindows = process.platform === 'win32'
const keep = process.argv.includes('--keep')

const harness = process.env.DSH_HARNESS
if (harness === undefined || harness === '') {
  console.log('SKIPPED: DSH_HARNESS is not set — cannot boot a real DSH process')
  process.exit(0)
}

const exeName = isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core'
const preset = isWindows ? 'dev-mingw' : 'dev'
const corePath = process.env.REPO_TUTOR_CORE ?? join(repoRoot, 'build', preset, 'apps', 'repo-tutor-core', exeName)

let failures = 0
function check(condition, message, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}${condition || detail === undefined ? '' : `\n      ${detail}`}`)
  if (!condition) failures += 1
}

const work = mkdtempSync(join(tmpdir(), 'repo-tutor-poc-'))
const dshHome = join(work, 'dsh-home')
const port = 3096
mkdirSync(dshHome, { recursive: true })
// 这个 PoC 不需要模型，但 DSH 启动时会读凭据存储；没有就照常起步（不建 agent）。
for (const name of ['.credentials.yaml', 'settings.yaml']) {
  const source = join(process.env.DSH_HOME_REAL ?? join(homedir(), '.dsh'), name)
  if (existsSync(source)) cpSync(source, join(dshHome, name))
}

// 模拟"npm 装好的包"：把包解开到一个 node_modules 位置，和 profile 里的布局一致。
const installedPkg = join(dshHome, 'profiles', 'poc', 'node_modules', 'repo-tutor-dsh')
mkdirSync(dirname(installedPkg), { recursive: true })
cpSync(packageRoot, installedPkg, {
  recursive: true,
  filter: (src) => !src.includes('node_modules') && !src.includes(`${join('hosts', 'dsh', 'test')}`),
})

// 关键布局：preset 目录必须在**包里面**，这样 `../src/index.js` 才指得回包自身的源码。
// 这正是"Bundle 自带 preset"会长的样子：<pkg>/poc-rel/agent.cordis.yml → ../src/index.js
const relativePreset = join(installedPkg, 'poc-rel')
const packagNamePreset = join(installedPkg, 'poc-pkgname')
for (const dir of [relativePreset, packagNamePreset]) mkdirSync(dir, { recursive: true })

const composition = (rowName) => `# PoC preset（不是产品路径）
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a PoC tutor.
- id: repo-tutor
  name: '${rowName}'
  config:
    alwaysOn: true
    corePath: '${corePath.replaceAll('\\', '/')}'
`
writeFileSync(join(relativePreset, 'agent.cordis.yml'), composition('../src/index.js'))
writeFileSync(join(packagNamePreset, 'agent.cordis.yml'), composition('repo-tutor-dsh'))

const overlay = join(work, 'overlay.yml')
writeFileSync(
  overlay,
  `- id: agent-presets
  config:
    default: standard
    roots:
      - path: '${installedPkg.replaceAll('\\', '/')}'
        trust: user
- insert:
    - id: rt-poc-probe
      name: '${join(work, 'probe.mjs').replaceAll('\\', '/')}'
`,
)

const probeOut = join(work, 'probe-result.json')
writeFileSync(
  join(work, 'probe.mjs'),
  `import { writeFileSync } from 'node:fs'

export const name = 'rt-poc-probe'
export const inject = ['agentPresets']

export function apply(ctx) {
  const out = process.env.RT_PROBE_OUT
  const result = { steps: [] }
  const write = () => { try { writeFileSync(out, JSON.stringify(result, null, 2)) } catch {} }
  setTimeout(async () => {
    try {
      const presets = await ctx.agentPresets.list()
      result.presets = presets.map((p) => ({ id: p.id, trust: p.trust, path: p.path, broken: p.broken ?? null }))
      result.standing = {}
      for (const id of ['poc-rel', 'poc-pkgname']) {
        try {
          await ctx.agentPresets.standingKeyFor(id)
          result.standing[id] = 'mounted'
        } catch (error) {
          result.standing[id] = 'FAILED: ' + error.message
        }
      }
      result.steps.push('done')
    } catch (error) {
      result.error = String(error?.stack ?? error)
    }
    write()
  }, 300)
}
`,
)

const tsxEntry = join(harness, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
const cliEntry = join(harness, 'apps', 'cli', 'src', 'bin.ts')
let server
try {
  server = spawn(
    process.execPath,
    ['--import', `file:///${tsxEntry.replaceAll('\\', '/')}`, cliEntry, '--profile', 'web', '--patch', overlay, '--port', String(port), '--no-open'],
    {
      cwd: work,
      env: { ...process.env, DSH_HOME: dshHome, TSX_TSCONFIG_PATH: join(harness, 'tsconfig.json'), RT_PROBE_OUT: probeOut },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  server.stdout.on('data', (c) => { log += c.toString() })
  server.stderr.on('data', (c) => { log += c.toString() })

  const deadline = Date.now() + 3 * 60 * 1000
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

  check(result !== undefined, 'the PoC probe answered', log.slice(-500))
  if (result !== undefined) {
    const byId = new Map((result.presets ?? []).map((p) => [p.id, p]))
    check(byId.has('poc-rel'), 'a bundle patch can add a preset root (roster sees poc-rel)', JSON.stringify([...byId.keys()]))
    check(byId.has('poc-pkgname'), 'the second PoC preset is listed too')
    check(
      result.standing['poc-rel'] === 'mounted',
      'a row pointing at ../src/index.js resolves and mounts',
      result.standing['poc-rel'],
    )
    check(
      (result.standing['poc-pkgname'] ?? '').startsWith('FAILED'),
      'a row naming the package does NOT resolve (it is looked up from the harness, not the profile)',
      result.standing['poc-pkgname'],
    )
    console.log(`\nstanding: ${JSON.stringify(result.standing, null, 2)}`)
  }
} catch (error) {
  check(false, `PoC crashed: ${error.message}`)
} finally {
  if (server !== undefined) {
    server.kill()
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (keep) console.log(`\nworkdir kept at ${work}`)
  else rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'all preset-root PoC checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
