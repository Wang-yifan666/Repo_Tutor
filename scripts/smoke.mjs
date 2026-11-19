// 一条命令跑通 smoke：
// 配置 + 构建 Core、跑 CTest、再用 node client 验证 adapter ↔ core 连通。
//
// 用法：
//   node scripts/smoke.mjs            # 本地：构建 + 测试 + 协议走查（不需要模型）
//   node scripts/smoke.mjs --model    # 再加上模型驱动验证（需要 DSH_HARNESS）

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

// 2. C++ 测试（Core 不变量 + 证据读取 + 协议黑盒 + 垂直切片）
run('ctest', ['--preset', preset, '--output-on-failure'])

// 3. adapter ↔ core 协议走查（不依赖 DSH）
run(process.execPath, [join(root, 'hosts', 'dsh', 'test', 'client-smoke.mjs'), exePath])

// 3.5 插件接线：11 个工具 / 教学 prompt 小节 / /tutor 命令都注册上，
//     仓库根取自会话的工作目录而不是宿主进程 cwd。
run(process.execPath, [join(root, 'hosts', 'dsh', 'test', 'plugin-wiring.mjs'), exePath])

// 3.6 发布自检：npm pack 白名单、解包、导师模式安装器、从解包目录驱动真实 Core。
//     这一步只在仓库里有意义（包里不带 test/），所以放在 repo 的 smoke 里跑。
run(process.execPath, [join(root, 'hosts', 'dsh', 'scripts', 'verify-package.mjs'), '--core', exePath])

// 3.7 安装器生命周期：重复安装、用户改动备份、升级清陈旧文件、卸载保留本地改动。
run(process.execPath, [join(root, 'hosts', 'dsh', 'test', 'installer-lifecycle.mjs')])

// 4. 模型驱动验证是可选的：要 DSH checkout，还会真的调模型。
if (process.argv.includes('--model')) {
  if (process.env.DSH_HARNESS === undefined || process.env.DSH_HARNESS === '') {
    console.error('FAILED: --model needs DSH_HARNESS=<dsh checkout>')
    process.exit(1)
  }
  run(process.execPath, [join(root, 'scripts', 'model-smoke.mjs'), exePath])
  run(process.execPath, [join(root, 'scripts', 'tutor-loop-smoke.mjs'), exePath])
}

console.log('smoke: all checks passed')
