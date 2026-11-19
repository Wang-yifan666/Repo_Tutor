// 模型驱动验证：让 DSH headless 调 tutor_status，确认模型真的能用到 Core。
// 需要 DSH checkout 和可用的 DEEPSEEK_API_KEY（DSH 的 credentials 里已有即可）。
// 用法：DSH_HARNESS=<dsh checkout> node scripts/model-smoke.mjs [core exe]

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const preset = isWindows ? 'dev-mingw' : 'dev'

const harness = process.env.DSH_HARNESS
if (harness === undefined || harness === '') {
  console.error('usage: DSH_HARNESS=<dsh checkout> node scripts/model-smoke.mjs [core exe]')
  process.exit(2)
}

const exePath =
  process.argv[2] ??
  process.env.REPO_TUTOR_CORE ??
  join(repoRoot, 'build', preset, 'apps', 'repo-tutor-core', isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core')

// 生成临时 overlay，避免依赖机器特定的 overlay.local.yml。
const dir = mkdtempSync(join(tmpdir(), 'repo-tutor-'))
const overlay = join(dir, 'overlay.yml')
const pluginPath = join(repoRoot, 'hosts', 'dsh', 'src', 'index.js').replaceAll('\\', '/')
writeFileSync(overlay, `- insert:\n    - id: repo-tutor\n      name: '${pluginPath}'\n`)

const task = 'Call the tutor_status tool and print its exact raw output.'

console.log(`$ pnpm dsh --profile headless --patch <overlay> "${task}"`)
const result = spawnSync('pnpm', ['dsh', '--profile', 'headless', '--patch', overlay, task], {
  cwd: harness,
  encoding: 'utf8',
  shell: isWindows,
  env: { ...process.env, REPO_TUTOR_CORE: exePath },
})

process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')

if (result.status !== 0) {
  console.error(`FAILED: dsh exited with ${result.status ?? 'signal'}`)
  process.exit(1)
}

if (!result.stdout.includes('"sessionId"')) {
  console.error('FAILED: model output did not include the tutor_status payload')
  process.exit(1)
}

console.log('model-smoke: model called tutor_status and got the core state')
