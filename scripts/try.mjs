// 一条命令在本机试玩 Repo Tutor：起一个带插件的 DSH Web，工作目录就是你想读的仓库。
//
// 为什么需要这个脚本：`dsh web` 的工作目录决定了两件事——DSH 的 workspace 和
// Repo Tutor 的仓库根。而 `pnpm dsh` 必须在 DSH checkout 里跑，两者对不上。
// 这个脚本用绝对路径调 CLI，把 cwd 留给目标仓库，再顺手把 tsx 的 tsconfig
// 钉回 checkout（不然从别的目录启动会解析错 @deepseek-ai/cordis）。
//
// 用法：
//   $env:DSH_HARNESS = "D:\DSH\deepseek-harness"
//   node scripts/try.mjs                       # 读本仓库
//   node scripts/try.mjs D:\path\to\repo       # 读别的仓库
//   node scripts/try.mjs D:\path\to\repo --port 3080 --no-open

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const preset = isWindows ? 'dev-mingw' : 'dev'
const exeName = isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core'

function usage(message) {
  if (message !== undefined) {
    console.error(`error: ${message}\n`)
  }
  console.error(
    'usage: DSH_HARNESS=<dsh checkout> node scripts/try.mjs [repo] [--port <n>] [--no-open]',
  )
  process.exit(2)
}

// ── 参数 ──────────────────────────────────────────────────────────────────

const passthrough = []
let targetArg
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--port') {
    passthrough.push('--port', argv[i + 1] ?? usage('--port needs a value'))
    i += 1
  } else if (arg === '--no-open') {
    passthrough.push('--no-open')
  } else if (arg.startsWith('-')) {
    usage(`unknown flag ${arg}`)
  } else if (targetArg === undefined) {
    targetArg = arg
  } else {
    usage(`unexpected argument ${arg}`)
  }
}

const target = resolve(targetArg ?? repoRoot)
if (!existsSync(target)) {
  usage(`repo path does not exist: ${target}`)
}

// ── DSH checkout ──────────────────────────────────────────────────────────

const harness = process.env.DSH_HARNESS
if (harness === undefined || harness === '') {
  usage('DSH_HARNESS is not set')
}

const cliEntry = join(harness, 'apps', 'cli', 'src', 'bin.ts')
const tsxEntry = join(harness, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
const tsconfig = join(harness, 'tsconfig.json')
for (const [path, what] of [
  [cliEntry, 'dsh CLI entry (is DSH_HARNESS right?)'],
  [tsxEntry, 'tsx loader'],
  [tsconfig, 'tsconfig'],
]) {
  if (!existsSync(path)) {
    usage(`missing ${what}: ${path}`)
  }
}

// ── Core 可执行文件 ───────────────────────────────────────────────────────

const exePath =
  process.env.REPO_TUTOR_CORE ?? join(repoRoot, 'build', preset, 'apps', 'repo-tutor-core', exeName)
if (!existsSync(exePath)) {
  console.error(`error: repo-tutor-core not built at ${exePath}`)
  console.error('build it first:')
  console.error('  cmake --preset dev-mingw && cmake --build --preset dev-mingw')
  process.exit(2)
}

// ── 临时 overlay：把插件按绝对路径挂进去，不依赖机器特定的 overlay.local.yml ──

const work = mkdtempSync(join(tmpdir(), 'repo-tutor-try-'))
const overlay = join(work, 'overlay.yml')
const pluginPath = join(repoRoot, 'hosts', 'dsh', 'src', 'index.js').replaceAll('\\', '/')
writeFileSync(overlay, `- insert:\n    - id: repo-tutor\n      name: '${pluginPath}'\n`)

// ── 起服务 ────────────────────────────────────────────────────────────────

console.log(`repo under tutelage: ${target}`)
console.log(`core executable   : ${exePath}`)
console.log(`workspace / cwd   : ${target}（DSH 的 workspace 和 tutor 的仓库根是同一个）`)
console.log('')

const child = spawn(
  process.execPath,
  ['--import', pathToFileURL(tsxEntry).href, cliEntry, 'web', '--patch', overlay, ...passthrough],
  {
    cwd: target,
    stdio: 'inherit',
    env: {
      ...process.env,
      REPO_TUTOR_CORE: exePath,
      REPO_TUTOR_ROOT: target,
      // 从别的目录启动时，tsx 默认拿 cwd 找 tsconfig，会把 workspace 包解析错。
      TSX_TSCONFIG_PATH: tsconfig,
    },
  },
)

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1))
})

// Ctrl+C 要传到子进程，不然会留一个后台 dsh。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
