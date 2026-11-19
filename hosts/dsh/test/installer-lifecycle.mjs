// 安装器的生命周期测试：重复安装、用户改动、升级、卸载、失效路径。
//
// 它只动一个临时 DSH_HOME，不碰真实的 $DSH_HOME，也不需要 DSH 在跑。
//
// 用法：node hosts/dsh/test/installer-lifecycle.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installer = join(packageRoot, 'scripts', 'install-preset.mjs')

let failures = 0
function check(condition, message, detail) {
  if (condition) {
    console.log(`ok    ${message}`)
  } else {
    failures += 1
    console.log(`FAIL  ${message}${detail === undefined ? '' : `\n      ${detail}`}`)
  }
}

function runInstaller(scriptPath, dshHome, args = []) {
  // stdout + stderr 一起收：备份提醒走 stderr，别让它从断言里消失。
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: dshHome, REPO_TUTOR_CORE: '' },
  })
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function runInstallerExpectFailure(scriptPath, dshHome, args = []) {
  try {
    execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: dshHome, REPO_TUTOR_CORE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return undefined
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

// 路径里故意带空格，覆盖 Windows / POSIX 都要处理的引号问题。
const work = mkdtempSync(join(tmpdir(), 'repo tutor lifecycle '))
const dshHome = join(work, 'dsh home')
const presetDir = join(dshHome, '.agent-presets', 'repo-tutor')
const listBackups = () =>
  existsSync(presetDir) ? readdirSync(presetDir).filter((name) => name.startsWith('backup-')) : []

try {
  // ── 1. 首次安装 ─────────────────────────────────────────────────────────
  runInstaller(installer, dshHome)
  const manifest = () => JSON.parse(readFileSync(join(presetDir, 'installed.json'), 'utf8'))
  check(existsSync(presetDir), 'install creates the preset directory')
  check(existsSync(join(presetDir, 'plugin', 'src', 'index.js')), 'install vendors src/index.js')
  check(
    existsSync(join(presetDir, 'plugin', 'policies', 'tutor-prompt.md')),
    'install vendors the teaching prompt',
  )
  check(manifest().version === '0.1.0', 'manifest records the package version')
  const composition = () => readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
  check(composition().includes("name: './plugin/src/index.js'"), 'row uses a preset-relative specifier')
  check(!/[A-Za-z]:[\\/]/.test(composition()), 'row carries no absolute drive path')
  check(listBackups().length === 0, 'first install creates no backup')

  // ── 2. 重复安装（同版本，未改动）───────────────────────────────────────
  runInstaller(installer, dshHome)
  check(listBackups().length === 0, 'reinstall over an untouched install creates no backup')
  check(manifest().version === '0.1.0', 'reinstall keeps the same version')

  // ── 3. 用户改动后再装 ───────────────────────────────────────────────────
  const userNote = '\n# 我自己的改动：第 2 单元改成先讲渲染\n'
  writeFileSync(join(presetDir, 'agent.cordis.yml'), composition() + userNote)
  writeFileSync(join(presetDir, 'custom-note.md'), '# 用户自己加的文件\n')
  rmSync(join(presetDir, 'plugin', 'src', 'core-client.mjs'))

  const output = runInstaller(installer, dshHome)
  const backups = listBackups()
  check(backups.length === 1, 'reinstall after a user edit creates exactly one backup directory', backups.join(','))
  const backupFile = join(presetDir, backups[0], 'agent.cordis.yml')
  check(
    existsSync(backupFile) && readFileSync(backupFile, 'utf8').includes('我自己的改动'),
    'the backup keeps the user-edited composition',
  )
  check(!composition().includes('我自己的改动'), 'the managed composition is restored')
  check(
    existsSync(join(presetDir, 'plugin', 'src', 'core-client.mjs')),
    'a deleted vendored file is restored',
  )
  check(existsSync(join(presetDir, 'custom-note.md')), 'a user-added file is left untouched')
  check(output.includes('edited'), 'the installer reports which files it backed up')

  // ── 4. 升级：版本变了 + 文件集合变了 ───────────────────────────────────
  const upgraded = join(work, 'pkg-0.1.1')
  cpSync(packageRoot, upgraded, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('/test/') && !src.includes('\\test\\'),
  })
  const upgradedManifest = JSON.parse(readFileSync(join(upgraded, 'package.json'), 'utf8'))
  upgradedManifest.version = '0.1.1'
  writeFileSync(join(upgraded, 'package.json'), JSON.stringify(upgradedManifest, null, 2))
  writeFileSync(join(upgraded, 'src', 'extra-0-1-1.mjs'), 'export const extra = 1\n')

  const upgradeOutput = runInstaller(join(upgraded, 'scripts', 'install-preset.mjs'), dshHome)
  check(manifest().version === '0.1.1', 'upgrade records the new version')
  check(upgradeOutput.includes('upgraded'), 'the installer reports an upgrade')
  check(
    existsSync(join(presetDir, 'plugin', 'src', 'extra-0-1-1.mjs')),
    'a file added in the new version is vendored',
  )

  // 再装回 0.1.0：新版本多出来的文件要被清掉（不残留失效路径）
  runInstaller(installer, dshHome)
  check(
    !existsSync(join(presetDir, 'plugin', 'src', 'extra-0-1-1.mjs')),
    'downgrade removes a file the older version does not ship',
  )
  check(manifest().version === '0.1.0', 'downgrade records the older version')

  // ── 5. 卸载（有本地改动时先保留）──────────────────────────────────────
  writeFileSync(join(presetDir, 'agent.cordis.yml'), composition() + userNote)
  const uninstallOutput = runInstaller(installer, dshHome, ['--uninstall'])
  const keptDirs = existsSync(presetDir)
    ? readdirSync(presetDir).filter((name) => name.startsWith('kept-'))
    : []
  check(keptDirs.length === 1, 'uninstall preserves a locally edited file under kept-*', keptDirs.join(','))
  const kept = join(presetDir, keptDirs[0], 'agent.cordis.yml')
  check(
    existsSync(kept) && readFileSync(kept, 'utf8').includes('我自己的改动'),
    'the preserved copy holds the user edit',
  )
  check(!existsSync(join(presetDir, 'plugin')), 'uninstall removes the vendored tree')
  check(!existsSync(join(presetDir, 'installed.json')), 'uninstall removes the manifest')
  check(uninstallOutput.includes('preserved'), 'the installer reports what it preserved')

  // ── 6. 装完再卸载（无改动）应该干干净净 ───────────────────────────────
  rmSync(presetDir, { recursive: true, force: true })
  runInstaller(installer, dshHome)
  runInstaller(installer, dshHome, ['--uninstall'])
  check(!existsSync(presetDir), 'uninstall with no local edits removes the preset directory entirely')

  // ── 7. 外部目录（没有我们的清单）不该被无声覆盖 ────────────────────────
  mkdirSync(presetDir, { recursive: true })
  writeFileSync(join(presetDir, 'agent.cordis.yml'), '# 不是我装的\n')
  const refused = runInstallerExpectFailure(installer, dshHome)
  check(refused !== undefined, 'install refuses to overwrite a foreign preset directory')
  check((refused ?? '').includes('--force'), 'the refusal tells the user about --force')
  runInstaller(installer, dshHome, ['--force'])
  check(manifest().version === '0.1.0', '--force installs over a foreign directory')

  // ── 8. 状态查询 ────────────────────────────────────────────────────────
  const status = runInstaller(installer, dshHome, ['--status'])
  check(status.includes('installed'), '--status reports the installed state')
  check(status.includes('0.1.0'), '--status reports the version')
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'all installer-lifecycle checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
