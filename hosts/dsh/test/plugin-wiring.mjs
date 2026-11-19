// 插件接线的确定性测试：不依赖 DSH，也不需要模型。
//
// 它盯的是几个"静默失败"的地方：
//   1. 工具真的注册了（11 个），少一个模型就少一条路。
//   2. 教学 prompt 小节注册上了。
//   3. `/tutor` 命令注册上了 —— 这个坑踩过：commands 服务在插件 apply 之后才挂上来，
//      旧代码用 ctx.get('commands') 只查一次，查不到就永久错过，命令静默消失。
//   4. 仓库根取自**会话的工作目录**，不是宿主进程的 cwd。踩过的坑：用户在
//      D:\Thunder_fighter_jet 里让 tutor 讲这个仓库，tutor 报的却是插件进程的 cwd。
//
// 用法：node hosts/dsh/test/plugin-wiring.mjs <repo-tutor-core-exe>

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exePath = process.argv[2]

function check(condition, message) {
  if (!condition) {
    console.error(`FAILED: ${message}`)
    process.exit(1)
  }
}

if (exePath === undefined) {
  console.error('usage: node plugin-wiring.mjs <repo-tutor-core-exe>')
  process.exit(2)
}

if (process.env.REPO_TUTOR_ROOT !== undefined && process.env.REPO_TUTOR_ROOT !== '') {
  console.error('FAILED: unset REPO_TUTOR_ROOT; this test checks that the session cwd wins')
  process.exit(1)
}

// 故意不设 REPO_TUTOR_CORE：装进 agent preset 时没有环境变量可用，
// 插件得自己从自己的位置倒推出 build 目录里的可执行文件。
delete process.env.REPO_TUTOR_CORE

// ── 一个够用的假 ctx：记录注册，并允许我们晚一点"把服务挂上来" ──────────────

function makeCtx() {
  const tools = new Map()
  const sections = []
  const commands = []
  const disposers = []
  const deferred = []

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
      },
    },
    // 和 Cordis 一致：工厂立刻执行，它返回的函数才是卸载时调用的 disposer。
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') {
        disposers.push(dispose)
      }
      return () => {}
    },
    // 故意永远查不到：模拟"服务在 apply 时还没挂上"。
    get() {
      return undefined
    },
    inject(deps, callback) {
      deferred.push({ deps, callback })
      return () => {}
    },
  }

  return { ctx, tools, sections, commands, disposers, deferred }
}

const plugin = await import('../src/index.js')
const { ctx, tools, sections, commands, disposers, deferred } = makeCtx()

plugin.apply(ctx)

check(tools.size === 11, `expected 11 tutor tools, got ${tools.size}: ${[...tools.keys()].join(', ')}`)

// 服务晚到：这就是真实的 Cordis 时序，插件 apply 时 commands 可能还不在。
check(deferred.length === 2, `expected 2 deferred injections, got ${deferred.length}`)
for (const { deps, callback } of deferred) {
  const child = {
    systemPrompt: {
      section(section) {
        check(deps.includes('systemPrompt'), 'systemPrompt injected under the wrong dependency')
        sections.push(section)
      },
    },
    commands: {
      register(definition) {
        check(deps.includes('commands'), 'commands injected under the wrong dependency')
        commands.push(definition)
      },
    },
  }
  callback(child)
}

check(sections.length === 1, `expected one prompt section, got ${sections.length}`)
check(sections[0].name === 'repo-tutor', 'prompt section should be named repo-tutor')
// section.text 是个函数：每次组装现读 policies/tutor-prompt.md。这里调一次，确认文件读得出来。
const sectionText = typeof sections[0].text === 'function' ? sections[0].text() : sections[0].text
check(
  sectionText.includes('## Repo Tutor') && sectionText.includes('Topic Lock'),
  'prompt section should carry the loop and the invariants',
)
check(
  sectionText.includes('1000 Chinese characters'),
  'prompt section should come from policies/tutor-prompt.md, not a stale in-code copy',
)
check(commands.length === 1, `expected the /tutor command to register, got ${commands.length}`)
check(commands[0].name === 'tutor', '/tutor command should be named tutor')

// ── 仓库根：会话的工作目录说了算 ──────────────────────────────────────────

const sessionRoot = mkdtempSync(join(tmpdir(), 'repo-tutor-wiring-'))
mkdirSync(join(sessionRoot, 'src'), { recursive: true })
writeFileSync(join(sessionRoot, 'src', 'main.cpp'), 'int main()\n{\n\treturn 0;\n}\n')
writeFileSync(join(sessionRoot, 'README.md'), '# wiring fixture\n')

// 模拟 DSH 交给工具的那个 exec：agent → session → header.cwd。
const exec = { agent: { session: { header: { cwd: sessionRoot } } } }

try {
  const status = await tools.get('tutor_status').execute({}, exec)
  check(status.sessionId === 'session-1', 'tutor_status should reach the Core')
  check(
    status.root.replaceAll('\\', '/').toLowerCase() === sessionRoot.replaceAll('\\', '/').toLowerCase(),
    `Core root should be the session workspace, got ${status.root}`,
  )

  const scan = await tools.get('tutor_scan_repository').execute({}, exec)
  check(scan.status === 'scanned', 'scan should succeed through the tool layer')
  check(scan.fileCount === 2, `scan should see the fixture files, got ${scan.fileCount}`)

  // 同一个仓库根再调一次，不该重新起会话（状态要接着走）。
  const proposed = await tools
    .get('tutor_propose_learning_map')
    .execute({ units: [{ id: 'unit-1', cognitiveGoal: 'how main is wired' }] }, exec)
  check(proposed.status === 'accepted', 'learning map should be accepted through the tool layer')

  const afterPropose = await tools.get('tutor_status').execute({}, exec)
  check(afterPropose.units.length === 1, 'the second call must see the same tutor session')

  // /tutor 命令走的是同一份会话，能读出真实状态。
  const commandOutput = await commands[0].handler({ agent: exec.agent, rawInput: '' })
  check(commandOutput.kind === 'success', `/tutor should succeed, got ${commandOutput.kind}`)
  check(
    commandOutput.text.includes('unit-1') && commandOutput.text.includes(sessionRoot),
    `/tutor should show the session it belongs to, got: ${commandOutput.text.slice(0, 200)}`,
  )

  console.log('all plugin-wiring checks passed')
} finally {
  // 插件卸载：disposer 关掉所有 Core 进程。
  for (const dispose of disposers) {
    dispose()
  }
  rmSync(sessionRoot, { recursive: true, force: true })
}
