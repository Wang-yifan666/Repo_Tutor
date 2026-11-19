// 一条命令跑通 v0.1 smoke：
// 配置 + 构建 Core、跑 CTest、再用 node client 验证 adapter ↔ core 连通。
// 用法：node scripts/smoke.mjs

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const preset = isWindows ? 'dev-mingw' : 'dev'

const exeName = isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core'
const exePath = join(root, 'build', preset, 'apps', 'repo-tutor-core', exeName)

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`FAILED: ${command} exited with ${result.status ?? 'signal'}`)
    process.exit(1)
  }
}

// 1. 配置 + 构建 Core
run('cmake', ['--preset', preset])
run('cmake', ['--build', '--preset', preset])

// 2. C++ 测试（Core 不变量 + 协议黑盒 + 垂直切片）
run('ctest', ['--preset', preset, '--output-on-failure'])

// 3. adapter ↔ core 连通（不依赖 DSH）
run(process.execPath, [join(root, 'hosts', 'dsh', 'test', 'client-smoke.mjs'), exePath])

console.log('smoke: all checks passed')
