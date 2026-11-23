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
  chmodSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  expectedProtocolVersion,
  findPlatformCore,
  missingPlatformCoreMessage,
} from '../src/platform-core.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const templateDir = join(packageRoot, 'preset')
const VENDOR_DIR = 'plugin'
const BIN_DIR = 'bin'
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
  const core = installed.core ?? {}
  log(
    `core     : ${
      core.mode === 'bundled'
        ? `${core.path} (copied from ${core.from})`
        : core.mode === 'external'
          ? `${core.path} (external, --core)`
          : '(none — the plugin will fall back to REPO_TUTOR_CORE)'
    }`,
  )
  log(`protocol : ${installed.protocolVersion ?? '(unknown)'}`)
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

// ── Core 计划：默认把平台包的二进制复制进受管理的 bin/ ────────────────────
//
// 复制而不是写绝对路径，有两个原因：
//   1. npx / npm 缓存随时会被清掉，写进持久化 preset 的绝对路径就失效了；
//   2. preset 目录要能整体搬走 —— 里面的行必须是相对路径。
// --core 保持"用户自己管"的语义：不复制，写绝对路径。
let corePlan = { mode: 'none' }
if (corePath !== undefined) {
  corePlan = { mode: 'external', path: corePath }
} else {
  const platform = findPlatformCore(manifest, { requireFrom: import.meta.url })
  if (platform.path !== undefined) {
    corePlan = { mode: 'copy', source: platform.path, packageName: platform.packageName }
  } else if ((process.env.REPO_TUTOR_CORE ?? '') !== '' && existsSync(process.env.REPO_TUTOR_CORE)) {
    // 没装平台包但用户自己给了环境变量：也复制进来，preset 才算自包含。
    corePlan = { mode: 'copy', source: process.env.REPO_TUTOR_CORE, packageName: 'REPO_TUTOR_CORE' }
  } else {
    corePlan = { mode: 'none', missing: platform.missing }
  }
}

// 复制模式：<preset>/bin/<basename>，行里写相对插件目录的 ../bin/<basename>。
const binRel = corePlan.mode === 'copy' ? `${BIN_DIR}/${basename(corePlan.source)}` : undefined
const coreLine =
  corePlan.mode === 'copy'
    ? `    corePath: ${yamlString(`../${binRel.replaceAll('\\', '/')}`)}`
    : corePlan.mode === 'external'
      ? `    corePath: ${yamlString(corePlan.path.replaceAll('\\', '/'))}`
      : ''

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

// 复制出来的插件目录要有自己的 package.json：没有它，Node 会按最近的 package.json
// 判断 .js 是不是 ESM（而 preset 目录上面通常什么都没有）。type: module 要写死。
outputs.set(
  `${VENDOR_DIR}/package.json`,
  `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: 'module',
      description: 'Vendored copy of repo-tutor-dsh, installed into a DSH agent preset.',
      repoTutor: { protocolVersion: expectedProtocolVersion(manifest) },
    },
    null,
    2,
  )}\n`,
)

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

// 旧版本 vendor/ 或 bin/ 里的文件如果这版不再需要，就清掉（不残留失效路径、旧二进制）
const managed = new Set([...outputs.keys(), ...vendorFiles.keys()])
if (binRel !== undefined) managed.add(binRel)

const staleFiles = []
if (previous !== undefined) {
  for (const rel of Object.keys(previous.files ?? {})) {
    if (managed.has(rel)) continue
    const abs = join(targetDir, rel)
    if (existsSync(abs)) staleFiles.push(rel)
  }
}

mkdirSync(targetDir, { recursive: true })
const written = {}

for (const [rel, content] of outputs) {
  backupIfEdited(rel, createHash('sha256').update(content).digest('hex'))
  const dest = join(targetDir, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, content)
  written[rel] = createHash('sha256').update(content).digest('hex')
}

for (const [rel, source] of vendorFiles) {
  backupIfEdited(rel, sha256(source))
  const dest = join(targetDir, rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(source, dest)
  written[rel] = sha256(dest)
}

if (binRel !== undefined) {
  const dest = join(targetDir, binRel)
  mkdirSync(dirname(dest), { recursive: true })
  backupIfEdited(binRel, sha256(corePlan.source))
  cpSync(corePlan.source, dest)
  // POSIX 上复制过来的文件不一定带执行位；Windows 没有这个概念。
  if (process.platform !== 'win32') chmodSync(dest, 0o755)
  written[binRel] = sha256(dest)
}

for (const rel of staleFiles) {
  rmSync(join(targetDir, rel), { force: true })
}

const installed = {
  package: manifest.name,
  version: manifest.version,
  id,
  installedAt: new Date().toISOString(),
  core: corePlan.mode === 'copy' ? { mode: 'bundled', path: binRel, from: corePlan.packageName } : corePlan.mode === 'external' ? { mode: 'external', path: corePlan.path } : { mode: 'none' },
  protocolVersion: expectedProtocolVersion(manifest),
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
if (binRel !== undefined && corePlan.mode === 'copy') {
  log(`  core   : copied ${corePlan.packageName} → ${binRel} (relative path, no cache dependency)`)
} else if (corePlan.mode === 'external') {
  log(`  core   : external ${corePlan.path} (--core, not managed by this tool)`)
}
if (staleFiles.length > 0) {
  log(`  removed: ${staleFiles.length} stale file(s) from the previous install`)
  for (const rel of staleFiles) log(`           ${rel}`)
}
if (backups.length > 0) {
  warn(`you had edited ${backups.length} file(s); the old copies are in ${backupDir}`)
  for (const rel of backups) warn(`  ${rel}`)
}

if (corePlan.mode === 'none') {
  warn('no platform package installed and no --core given: the preset cannot start the Core')
  warn(`  ${corePlan.missing ?? 'no platform package for this platform'}`)
  warn('  fix: npm i the matching @…/core-<platform>-<arch> package, or rerun with --core <path>')
} else if (corePlan.mode === 'external' && !existsSync(corePlan.path)) {
  warn(`pinned corePath no longer exists: ${corePlan.path}`)
}

log('')
log('启动 DSH 后在模式选择器里选「导师模式」。')
log('显示名和说明立刻生效（roster 每次重读目录），但行为要重启 DSH 进程：')
log('preset 一旦被某个会话挂载过，这份组合就钉在那个进程里，直到进程退出。')
log('')
// 这条目录式 preset 在 DSH 0.2 之后没有任何代码去读了；0.2 的导师模式由
// cordis.patch.yml 里的 preset-repo-tutor 声明提供，装 bundle 就会带上。
warn('DSH 0.2 及以后不再读取 $DSH_HOME/.agent-presets/：那边请用 `dsh plugin --profile <p> add repo-tutor-dsh`，')
warn('导师模式随 bundle 声明一起出现，不需要再跑这个安装器。本工具只对 0.1.x 有意义。')

