// 把 hosts/dsh/preset 下的模板装成一个本机 agent preset（DSH 的"第五个模式"）。
//
// 装到 $DSH_HOME/.agent-presets/repo-tutor/：
//   - preset.yml       显示名和说明（出现在模式选择器里）
//   - agent.cordis.yml 教学模式的组合，占位符换成本机插件的绝对路径
//
// DSH 的 roster 每次都重读目录，所以装完不用重启：新开会话时模式列表里就有了。
//
// 用法：node scripts/install-preset.mjs [--id repo-tutor]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templateDir = join(repoRoot, 'hosts', 'dsh', 'preset')
const pluginPath = join(repoRoot, 'hosts', 'dsh', 'src', 'index.js')

const idFlag = process.argv.indexOf('--id')
const id = idFlag === -1 ? 'repo-tutor' : process.argv[idFlag + 1]
if (id === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error('error: --id must match [a-z0-9][a-z0-9-]*')
  process.exit(2)
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const targetDir = join(dshHome, '.agent-presets', id)

if (!existsSync(join(templateDir, 'agent.cordis.yml'))) {
  console.error(`error: template missing at ${templateDir}`)
  process.exit(2)
}

// 行名是模块标识符：Windows 路径里的反斜杠和空格都不适合，统一成 '/'
const pluginSpecifier = pluginPath.replaceAll('\\', '/')

mkdirSync(targetDir, { recursive: true })

for (const name of ['preset.yml', 'agent.cordis.yml']) {
  const source = readFileSync(join(templateDir, name), 'utf8')
  const rendered = source.replaceAll('__REPO_TUTOR_PLUGIN__', pluginSpecifier)
  writeFileSync(join(targetDir, name), rendered)
  console.log(`wrote ${join(targetDir, name)}`)
}

console.log(`\npreset "${id}" installed into ${targetDir}`)
console.log(
  '显示名和说明立刻生效（roster 每次重读目录），但**行为要重启 DSH 进程**：\n' +
    'preset 一旦被某个会话挂载过，这份组合就钉在那个进程里，直到进程退出。\n' +
    '所以改完模板或插件代码，重启 DSH（关掉 dsh web 再开）才会用上新版本。',
)
