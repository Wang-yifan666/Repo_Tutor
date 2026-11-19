// 平台 Core 的解析：主包和安装器共用这一份，避免两边规则漂移。
//
// 平台包的 package.json 里声明：
//   { "repoTutor": { "core": "bin/repo-tutor-core.exe", "protocolVersion": "0.1" } }
// 主包用 optionalDependencies 精确锁版本，所以这里既不用猜文件名，也不写死 scope ——
// scope 只有一个来源：主包自己的 manifest。

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Core 讲哪一版协议。主包 manifest 里的 repoTutor.protocolVersion 是唯一来源。 */
export function expectedProtocolVersion(manifest) {
  return manifest.repoTutor?.protocolVersion ?? '0.1'
}

/** 当前 Node 进程对应的平台后缀，和 optionalDependencies 里的名字对得上。 */
export function platformSuffix(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/** 主包里为当前平台声明的平台包名，没声明就是 undefined。 */
export function declaredPlatformPackage(manifest, suffix = platformSuffix()) {
  const optional = manifest.optionalDependencies ?? {}
  return Object.keys(optional).find(
    (name) => name.endsWith(`/core-${suffix}`) || name === `core-${suffix}`,
  )
}

/**
 * 找到当前平台的 Core。
 * @returns {{ path: string, packageName: string, version: string, protocolVersion?: string }
 *   | { missing: string, packageName?: string }}
 */
export function findPlatformCore(manifest, { requireFrom, suffix = platformSuffix() } = {}) {
  const packageName = declaredPlatformPackage(manifest, suffix)
  if (packageName === undefined) {
    return { missing: `this package declares no platform package for ${suffix}` }
  }

  const wanted = manifest.optionalDependencies?.[packageName]
  const require = createRequire(requireFrom)

  let manifestPath
  try {
    manifestPath = require.resolve(`${packageName}/package.json`)
  } catch {
    return { packageName, missing: `${packageName}@${wanted} is not installed` }
  }

  const platformManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (platformManifest.version !== manifest.version) {
    return {
      packageName,
      missing:
        `${packageName}@${platformManifest.version} does not match ${manifest.name}@${manifest.version}; ` +
        'the platform package is version-locked to the main package',
    }
  }

  const entry = platformManifest.repoTutor?.core
  if (typeof entry !== 'string' || entry === '') {
    return { packageName, missing: `${packageName} declares no repoTutor.core entry` }
  }
  const path = join(dirname(manifestPath), entry)
  if (!existsSync(path)) {
    return { packageName, missing: `${packageName} is installed but ${entry} is missing` }
  }

  return { path, packageName, version: platformManifest.version, protocolVersion: platformManifest.repoTutor?.protocolVersion }
}

/** 缺平台包时那条会出现在 DSH 日志里的错误文本。 */
export function missingPlatformCoreMessage(manifest, miss, suffix = platformSuffix()) {
  const packageName = miss.packageName ?? declaredPlatformPackage(manifest, suffix) ?? `@scope/core-${suffix}`
  return (
    `repo-tutor-dsh: repo-tutor-core not found for ${suffix}.\n` +
    `  ${miss.missing}\n` +
    '  Fix one of:\n' +
    `    - reinstall with optional dependencies enabled (npm i ${manifest.name} without --omit=optional)\n` +
    `    - install the platform package explicitly: npm i ${packageName}\n` +
    '    - set REPO_TUTOR_CORE to an executable you manage yourself\n' +
    '    - set corePath in the plugin row to an executable you manage yourself'
  )
}
