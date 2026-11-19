#!/usr/bin/env node
// 把「导师模式」装成一个本机 agent preset（DSH 的第五个模式）。
//
// 装到 $DSH_HOME/.agent-presets/<id>/：
//   preset.yml            显示名和说明（出现在模式选择器里）
//   agent.cordis.yml      教学模式的组合
//   plugin/src/*.js       插件本体（复制进来）
//   plugin/policies/*.md  教学 prompt（复制进来）
//
// 为什么把插件复制进 preset 目录，而不是让行去引用包名或者 node_modules 路径：
//
//   DSH 解析 preset 行里的「包名」时，基准是**已安装的 harness**，不是用户的 profile。
//   从 npm 装到 profile 里的包，harness 那边根本看不见，行会解析失败。
//   而 `./` 开头的名字是按 preset 自己的目录解析的（Include 会改写 baseUrl），
//   所以把文件复制进来、写成 ./plugin/src/index.js，从 checkout 跑和从 npm 包跑都一样。
//
// 用法：
//   repo-tutor-install-preset [--id repo-tutor] [--core <repo-tutor-core 路径>] [--print-dir]
//
// 不给 --core 也行：插件会去读 REPO_TUTOR_CORE 环境变量。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templateDir = join(packageRoot, 'preset')
const VENDOR_DIR = 'plugin'

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(2)
}

// ── 参数 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let id = 'repo-tutor'
let corePath
let printDir = false

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--id') {
    id = argv[i + 1]
    if (id === undefined) fail('--id needs a value')
    i += 1
  } else if (arg === '--core') {
    corePath = argv[i + 1]
    if (corePath === undefined) fail('--core needs a value')
    i += 1
  } else if (arg === '--print-dir') {
    printDir = true
  } else {
    fail(`unknown argument ${arg}`)
  }
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  fail('--id must match [a-z0-9][a-z0-9-]* (it becomes the directory name)')
}

if (corePath !== undefined) {
  corePath = resolve(corePath)
  if (!existsSync(corePath)) fail(`--core does not exist: ${corePath}`)
}

// ── 目标目录 ──────────────────────────────────────────────────────────────

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const targetDir = join(dshHome, '.agent-presets', id)

if (printDir) {
  process.stdout.write(targetDir)
  process.exit(0)
}

for (const name of ['preset.yml', 'agent.cordis.yml']) {
  if (!existsSync(join(templateDir, name))) fail(`template missing: ${join(templateDir, name)}`)
}

// ── 复制插件本体 ──────────────────────────────────────────────────────────

const vendor = join(targetDir, VENDOR_DIR)
rmSync(vendor, { recursive: true, force: true })
mkdirSync(vendor, { recursive: true })
cpSync(join(packageRoot, 'src'), join(vendor, 'src'), { recursive: true })
cpSync(join(packageRoot, 'policies'), join(vendor, 'policies'), { recursive: true })

// ── 写组合 ────────────────────────────────────────────────────────────────

// YAML 单引号字符串：内部的单引号要写成两个。
const yamlString = (value) => `'${value.replaceAll("'", "''")}'`
const coreLine =
  corePath === undefined ? '' : `    corePath: ${yamlString(corePath.replaceAll('\\', '/'))}`

mkdirSync(targetDir, { recursive: true })

for (const name of ['preset.yml', 'agent.cordis.yml']) {
  const source = readFileSync(join(templateDir, name), 'utf8')
  const rendered = source
    .replaceAll('__REPO_TUTOR_PLUGIN__', `./${VENDOR_DIR}/src/index.js`)
    .replaceAll('__REPO_TUTOR_CORE_LINE__', coreLine)
  writeFileSync(join(targetDir, name), rendered)
  console.log(`wrote ${join(targetDir, name)}`)
}
console.log(`vendored plugin into ${vendor}`)

console.log(`\n导师模式 "${id}" 已装到 ${targetDir}`)
if (corePath === undefined && (process.env.REPO_TUTOR_CORE ?? '') === '') {
  console.log(
    '注意：没指定 --core，也没设 REPO_TUTOR_CORE。启动 DSH 前必须给一个，\n' +
      '否则插件挂载时会报 "repo-tutor-core not found"。也可以用 --core 重装一次写死路径。',
  )
}
console.log(
  '\n显示名和说明立刻生效（roster 每次重读目录），但**行为要重启 DSH 进程**：\n' +
    'preset 一旦被某个会话挂载过，这份组合就钉在那个进程里，直到进程退出。',
)
