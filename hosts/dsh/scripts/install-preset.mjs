#!/usr/bin/env node
// 把「导师模式」装成一个本机 agent preset（DSH 的第五个模式）。
//
// 装到 $DSH_HOME/.agent-presets/<id>/：
//   preset.yml            显示名和说明（出现在模式选择器里）
//   agent.cordis.yml      教学模式的组合
//   plugin/src/*.js       插件本体（复制进来）
//   plugin/policies/*.md  教学 prompt（复制进来）
//   installed.json        安装清单：版本、Core 路径、每个受管文件的 sha256
//
// 为什么把插件复制进 preset 目录，而不是让行去引用包名或者 node_modules 路径：
//
//   DSH 解析 preset 行里的「包名」时，基准是**已安装的 harness**，不是用户的 profile。
//   从 npm 装到 profile 里的包，harness 那边根本看不见，行会解析失败。
//   而 `./` 开头的名字是按 preset 自己的目录解析的（Include 会改写 baseUrl），
//   所以把文件复制进来、写成 ./plugin/src/index.js，从 checkout 跑和从 npm 包跑都一样。
//
// 重复安装 / 升级 / 卸载的约定：
//   - installed.json 记录我们写过哪些文件、内容是什么（sha256）
//   - 内容没变 = 我们自己写的，直接覆盖
//   - 内容变了 = 用户改过，覆盖前先整体备份到 backup-<时间戳>/，并在输出里点名
//   - 卸载只删「还是我们写的那份」的文件；用户改过的一律备份保留
//
// 用法：
//   repo-tutor-dsh                 # 安装 / 升级
//   repo-tutor-dsh --core <路径>   # 顺带把 Core 路径写进 preset
//   repo-tutor-dsh --uninstall     # 卸载
//   repo-tutor-dsh --status        # 看装了什么、装在哪
//   repo-tutor-dsh --version

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const templateDir = join(packageRoot, 'preset')
const VENDOR_DIR = 'plugin'
const MANIFEST_FILE = 'installed.json'

// ── 小工具 ────────────────────────────────────────────────────────────────

const log = (message) => console.log(message)
const warn = (message) => console.error(`warning: ${message}`)

function fail(message, hint) {
  console.error(`error: ${message}`)
  if (hint !== undefined) console.error(`       ${hint}`)
  process.exit(2)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 相对路径用 '/' 分隔，装进清单时和平台无关。 */
function toPosix(path) {
  return path.split(sep).join('/')
}

function walkFiles(dir, prefix = '') {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...walkFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) found.push(rel)
  }
  return found
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

// ── 参数 ──────────────────────────────────────────────────────────────────

const USAGE = `repo-tutor-dsh ${manifest.version} — 安装 / 升级 / 卸载 DSH 导师模式

用法：
  repo-tutor-dsh                    安装或升级导师模式
  repo-tutor-dsh --core <路径>      安装时把 repo-tutor-core 路径写进 preset
  repo-tutor-dsh --uninstall        卸载（用户改过的文件会先备份）
  repo-tutor-dsh --uninstall --force 强制卸载，不保留备份
  repo-tutor-dsh --status           看看装了什么
  repo-tutor-dsh --id <id>          preset 目录名（默认 repo-tutor）
  repo-tutor-dsh --version          打印版本
  repo-tutor-dsh --help             打印这段

环境变量：
  DSH_HOME   DSH 的 home 目录（默认 ~/.dsh）
  REPO_TUTOR_CORE  repo-tutor-core 可执行文件路径
`

const argv = process.argv.slice(2)
let id = 'repo-tutor'
let corePath
let mode = 'install'
let force = false

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
  } else if (arg === '--uninstall') {
    mode = 'uninstall'
  } else if (arg === '--status') {
    mode = 'status'
  } else if (arg === '--force') {
    force = true
  } else if (arg === '--version' || arg === '-v') {
    log(manifest.version)
    process.exit(0)
  } else if (arg === '--help' || arg === '-h') {
    log(USAGE)
    process.exit(0)
  } else {
    fail(`unknown argument ${arg}`, 'run with --help to see the supported flags')
  }
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  fail('--id must match [a-z0-9][a-z0-9-]* (it becomes the directory name)')
}

if (corePath !== undefined) {
  corePath = resolve(corePath)
  if (!existsSync(corePath)) {
    fail(`--core does not exist: ${corePath}`, 'point it at the built repo-tutor-core executable')
  }
  if (!statSync(corePath).isFile()) {
    fail(`--core is not a file: ${corePath}`)
  }
}

// ── 目录 ──────────────────────────────────────────────────────────────────

const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const targetDir = join(dshHome, '.agent-presets', id)
const backupDir = join(targetDir, `backup-${timestamp()}`)
const manifestPath = join(targetDir, MANIFEST_FILE)

function readInstalled() {
  if (!existsSync(manifestPath)) return undefined
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`cannot read ${manifestPath}: ${error.message}`, 'delete it if it is corrupt, then install again')
  }
}

// ── status ────────────────────────────────────────────────────────────────

if (mode === 'status') {
  const installed = readInstalled()
  log(`target   : ${targetDir}`)
  if (installed === undefined) {
    log('state    : not installed')
    process.exit(0)
  }
  log(`state    : installed`)
  log(`version  : ${installed.version}`)
  log(`corePath : ${installed.corePath ?? '(not pinned — the plugin reads REPO_TUTOR_CORE)'}`)
  log(`installed: ${installed.installedAt}`)
  const changed = Object.entries(installed.files ?? {})
    .filter(([rel, hash]) => {
      const abs = join(targetDir, rel)
      return !existsSync(abs) || sha256(abs) !== hash
    })
    .map(([rel]) => rel)
  log(changed.length === 0 ? 'local edits: none' : `local edits: ${changed.join(', ')}`)
  process.exit(0)
}

// ── uninstall ─────────────────────────────────────────────────────────────

if (mode === 'uninstall') {
  const installed = readInstalled()
  if (installed === undefined) {
    if (!existsSync(targetDir)) {
      log(`nothing to uninstall: ${targetDir}`)
      process.exit(0)
    }
    fail(
      `${targetDir} exists but was not installed by this tool`,
      'remove it yourself, or install first so we know which files are ours',
    )
  }

  const removed = []
  const kept = []
  for (const rel of Object.keys(installed.files ?? {})) {
    const abs = join(targetDir, rel)
    if (!existsSync(abs)) continue
    const untouched = sha256(abs) === installed.files[rel]
    if (untouched || force) {
      rmSync(abs, { force: true })
      removed.push(rel)
    } else {
      kept.push(rel)
    }
  }

  // 用户改过的文件：默认原样留着，让用户自己决定
  if (kept.length > 0) {
    const keepDir = join(targetDir, `kept-${timestamp()}`)
    for (const rel of kept) {
      const abs = join(targetDir, rel)
      const dest = join(keepDir, rel)
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(abs, dest)
      rmSync(abs, { force: true })
    }
    log(`preserved ${kept.length} locally edited file(s) under ${keepDir}`)
  }

  rmSync(manifestPath, { force: true })

  // 自下而上剪掉空目录：plugin/src、plugin/policies、plugin、preset 目录本身。
  // 非空（用户的备份 / 保留目录）一律不动。
  const pruneEmpty = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) pruneEmpty(join(dir, entry.name))
    }
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
  }
  pruneEmpty(targetDir)

  log(`removed ${removed.length} file(s) from ${targetDir}`)
  if (existsSync(targetDir)) {
    const left = walkFiles(targetDir)
    log(`left in place: ${left.length === 0 ? '(empty)' : left.join(', ')}`)
  } else {
    log('preset directory removed')
  }
  log('')
  log('重启 DSH 之后，模式选择器里就没有这个模式了。已经开过的会话会记着它，重新选一次模式即可。')
  process.exit(0)
}

// ── install ───────────────────────────────────────────────────────────────

for (const name of ['preset.yml', 'agent.cordis.yml']) {
  if (!existsSync(join(templateDir, name))) fail(`template missing: ${join(templateDir, name)}`)
}

const previous = readInstalled()

// 目录存在但没有清单：不是我们装的，可能是手写 preset 或者别的版本装的。
if (existsSync(targetDir) && previous === undefined) {
  const existing = walkFiles(targetDir)
  if (existing.length > 0 && !force) {
    fail(
      `${targetDir} already exists and was not installed by this tool (${existing.length} file(s))`,
      'pass --force to install anyway (existing files are backed up first)',
    )
  }
}

// YAML 单引号字符串：内部的单引号要写成两个。
const yamlString = (value) => `'${value.replaceAll("'", "''")}'`
const pinnedCore =
  corePath ?? (previous?.corePath !== undefined && existsSync(previous.corePath) ? undefined : undefined)
const coreLine = (corePath ?? previous?.corePath) === undefined
  ? ''
  : `    corePath: ${yamlString(String(corePath ?? previous?.corePath).replaceAll('\\', '/'))}`

// 先算好要写什么，再统一备份 / 覆盖，避免写一半。
const outputs = new Map()
for (const name of ['preset.yml', 'agent.cordis.yml']) {
  const source = readFileSync(join(templateDir, name), 'utf8')
  outputs.set(
    name,
    source
      .replaceAll('__REPO_TUTOR_PLUGIN__', `./${VENDOR_DIR}/src/index.js`)
      .replaceAll('__REPO_TUTOR_CORE_LINE__', coreLine),
  )
}

const vendorFiles = new Map()
for (const rel of walkFiles(join(packageRoot, 'src'))) {
  vendorFiles.set(`${VENDOR_DIR}/src/${rel}`, join(packageRoot, 'src', rel))
}
for (const rel of walkFiles(join(packageRoot, 'policies'))) {
  vendorFiles.set(`${VENDOR_DIR}/policies/${rel}`, join(packageRoot, 'policies', rel))
}

// 备份：内容与我们上次写的不一致 = 用户改过
const backups = []
function backupIfEdited(rel, nextContentHash) {
  const abs = join(targetDir, rel)
  if (!existsSync(abs)) return
  const recorded = previous?.files?.[rel]
  const current = sha256(abs)
  const unchanged = recorded !== undefined ? current === recorded : nextContentHash === current
  if (unchanged) return
  const dest = join(backupDir, rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(abs, dest)
  backups.push(rel)
}

// 旧版本 plugin/ 里的文件如果这版没有了，也要清理（不残留失效路径）
const staleVendor = []
if (previous !== undefined) {
  for (const rel of Object.keys(previous.files ?? {})) {
    if (!rel.startsWith(`${VENDOR_DIR}/`)) continue
    if (vendorFiles.has(rel)) continue
    const abs = join(targetDir, rel)
    if (existsSync(abs)) staleVendor.push(rel)
  }
}

mkdirSync(targetDir, { recursive: true })
const written = {}

for (const [rel, content] of outputs) {
  backupIfEdited(rel, createHash('sha256').update(content).digest('hex'))
  writeFileSync(join(targetDir, rel), content)
  written[rel] = createHash('sha256').update(content).digest('hex')
}

for (const [rel, source] of vendorFiles) {
  backupIfEdited(rel, sha256(source))
  const dest = join(targetDir, rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(source, dest)
  written[rel] = sha256(dest)
}

for (const rel of staleVendor) {
  rmSync(join(targetDir, rel), { force: true })
}

const installed = {
  package: manifest.name,
  version: manifest.version,
  id,
  installedAt: new Date().toISOString(),
  corePath: corePath ?? previous?.corePath,
  files: written,
}
writeFileSync(manifestPath, `${JSON.stringify(installed, null, 2)}\n`)

// ── 输出 ──────────────────────────────────────────────────────────────────

const action = previous === undefined ? 'installed' : previous.version === manifest.version ? 'reinstalled' : 'upgraded'
log(`${action} ${manifest.name}@${manifest.version} → ${targetDir}`)
if (previous !== undefined && previous.version !== manifest.version) {
  log(`  version: ${previous.version} → ${manifest.version}`)
}
log(`  files  : ${Object.keys(written).length} managed (${vendorFiles.size} vendored)`)
if (staleVendor.length > 0) log(`  removed: ${staleVendor.length} stale file(s) from the previous version`)
if (backups.length > 0) {
  warn(`you had edited ${backups.length} file(s); the old copies are in ${backupDir}`)
  for (const rel of backups) warn(`  ${rel}`)
}

const effectiveCore = corePath ?? previous?.corePath
if (effectiveCore === undefined && (process.env.REPO_TUTOR_CORE ?? '') === '') {
  warn(
    'no --core given and REPO_TUTOR_CORE is empty: the plugin will refuse to mount until one is set',
  )
  warn('  fix: rerun with --core <path>, or export REPO_TUTOR_CORE before starting DSH')
} else if (effectiveCore !== undefined && !existsSync(effectiveCore)) {
  warn(`pinned corePath no longer exists: ${effectiveCore}`)
  warn('  rerun with --core <path> after rebuilding the Core')
}

log('')
log('启动 DSH 后在模式选择器里选「导师模式」。')
log('显示名和说明立刻生效（roster 每次重读目录），但行为要重启 DSH 进程：')
log('preset 一旦被某个会话挂载过，这份组合就钉在那个进程里，直到进程退出。')
