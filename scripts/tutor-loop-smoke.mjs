// 模型驱动的完整教学闭环验证。
//
// 前面的测试证明"协议能跑通"，这个脚本证明"模型能自己把闭环跑完"：
// 模型通过 DSH 的 tutor_* 工具，从一个陌生仓库开始，走完
// scan → propose map → open unit → evidence → question → answer → evaluation
// → complete → 下一个单元。
//
// 判定不靠模型自己汇报（它会自由发挥），而是靠 Core 在 stderr 上打的协议轨迹：
// REPO_TUTOR_TRACE=1 时，Core 每处理一条请求就把 method 和响应摘一行到 stderr。
// 这条轨迹是 Core 亲眼看到的调用顺序，模型没做过的事不会出现。
//
// 用法：DSH_HARNESS=<dsh checkout> node scripts/tutor-loop-smoke.mjs [core exe]

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const preset = isWindows ? 'dev-mingw' : 'dev'

const harness = process.env.DSH_HARNESS
if (harness === undefined || harness === '') {
  console.error('usage: DSH_HARNESS=<dsh checkout> node scripts/tutor-loop-smoke.mjs [core exe]')
  process.exit(2)
}

const exePath =
  process.argv[2] ??
  process.env.REPO_TUTOR_CORE ??
  join(repoRoot, 'build', preset, 'apps', 'repo-tutor-core', isWindows ? 'repo-tutor-core.exe' : 'repo-tutor-core')

// ── 造一个陌生仓库：两个文件、两个目录、一个能讲清的机制 ──────────────────

const work = mkdtempSync(join(tmpdir(), 'repo-tutor-loop-'))
const fixture = join(work, 'fixture-repo')
mkdirSync(join(fixture, 'src'), { recursive: true })
mkdirSync(join(fixture, 'lib'), { recursive: true })

writeFileSync(
  join(fixture, 'src', 'main.cpp'),
  '#include "../lib/calc.hpp"\n\nint main()\n{\n\treturn add(2, 3) == 5 ? 0 : 1;\n}\n',
)
writeFileSync(join(fixture, 'lib', 'calc.hpp'), '#pragma once\n\nint add(int a, int b);\n')
writeFileSync(
  join(fixture, 'lib', 'calc.cpp'),
  '#include "calc.hpp"\n\nint add(int a, int b)\n{\n\treturn a + b;\n}\n',
)
writeFileSync(join(fixture, 'README.md'), '# fixture\n\nA tiny add() demo used by the repo tutor smoke test.\n')

const overlay = join(work, 'overlay.yml')
const pluginPath = join(repoRoot, 'hosts', 'dsh', 'src', 'index.js').replaceAll('\\', '/')
writeFileSync(overlay, `- insert:\n    - id: repo-tutor\n      name: '${pluginPath}'\n`)

// ── 让模型把闭环跑完 ──────────────────────────────────────────────────────

const task = `AUTOMATED SMOKE TEST — there is no human in this session. You are both the tutor and the learner, and you must finish everything in this run.

Exercise the complete Repo Tutor loop on the repository at ${fixture}, in exactly this order:
1. tutor_status
2. tutor_scan_repository
3. tutor_propose_learning_map with exactly two units: "unit-1" about how main() delegates work, and "unit-2" about how add() is implemented. Each needs a concrete cognitiveGoal.
4. tutor_open_unit unit-1
5. tutor_evidence_read a relevant slice of src/main.cpp with a rationale
6. tutor_question_create one open_answer question about that slice, with a premise and evaluationCriteria
7. tutor_answer_submit a short plausible learner answer — invent it yourself, do not wait for anyone
8. tutor_evaluation_record judging that answer
9. tutor_complete_unit unit-1
10. tutor_open_unit unit-2
11. tutor_status, and print its raw JSON output as your final answer.

Keep every explanation short — this run is about exercising the protocol, not about the prose. Never end your turn to wait for an answer: if you create a question, answer and evaluate it yourself in the same run. Do not skip steps.`

console.log(`$ pnpm dsh --profile headless --patch <overlay> "<tutor loop task>"`)
const result = spawnSync('pnpm', ['dsh', '--profile', 'headless', '--patch', overlay, task], {
  cwd: harness,
  encoding: 'utf8',
  shell: isWindows,
  env: {
    ...process.env,
    REPO_TUTOR_CORE: exePath,
    REPO_TUTOR_ROOT: fixture,
    REPO_TUTOR_TRACE: '1',
  },
  maxBuffer: 32 * 1024 * 1024,
})

const stdout = result.stdout ?? ''
const stderr = result.stderr ?? ''

// 模型每次跑完都留一份完整日志，出问题不用重跑才能看见现场。
const logPath = join(repoRoot, 'build', 'tutor-loop-smoke.log')
mkdirSync(dirname(logPath), { recursive: true })
writeFileSync(
  logPath,
  `# pnpm dsh --profile headless --patch ${overlay}\n# task:\n${task}\n\n## stdout\n${stdout}\n\n## stderr\n${stderr}\n`,
)
console.log(`full log: ${logPath}`)

// ── 从 Core 的协议轨迹里读真相 ────────────────────────────────────────────

// 一行长这样：[repo-tutor] [core] repository.scan -> {"status":"scanned",...}
const TRACE = /\[core\] (\S+) -> (.*)$/gm
const calls = []
for (const match of (stdout + '\n' + stderr).matchAll(TRACE)) {
  calls.push({ method: match[1], response: match[2] })
}

function fail(message) {
  console.error(`\nFAILED: ${message}`)
  if (calls.length > 0) {
    console.error('\nCore saw these calls:')
    for (const call of calls) {
      console.error(`  ${call.method} -> ${call.response.slice(0, 160)}`)
    }
  } else {
    console.error('\nCore saw no calls at all — the plugin or the model never reached it.')
  }
  if (stdout.trim() !== '') {
    console.error(`\nmodel stdout:\n${stdout.slice(-3000)}`)
  }
  if (stderr.trim() !== '') {
    console.error(`\nmodel stderr:\n${stderr.slice(-3000)}`)
  }
  console.error(`\nfixture and overlay kept at ${work}`)
  process.exit(1)
}

// 1. 顺序：按顺序出现的子序列，允许中间有重复或绕路。
//    每个 EXPECTED 步配一句"这一步该返回什么"，用来确认 Core 真的接受了这次转移，
//    而不是被状态机拦下来之后模型自己往下编。
const EXPECTED = [
  ['session.start', '"sessionId"', '会话要起来'],
  ['repository.scan', '"status":"scanned"', '仓库扫描要成功'],
  ['learning_map.propose', '"status":"accepted"', '学习地图要被接受'],
  ['unit.open', '"status":"opened"', '第一个单元要能打开'],
  ['evidence.read', '"status":"recorded"', '证据要真的读到'],
  ['question.create', '"status":"created"', '题目要能创建'],
  ['answer.submit', '"status":"recorded"', '回答要能提交'],
  ['evaluation.record', '"status":"recorded"', '评价要能记录'],
  ['unit.complete', '"status":"completed"', '单元要能完成'],
  ['unit.open', '"status":"opened"', '第二个单元要能打开'],
  ['session.get', '"currentUnitId":"unit-', '结束时要停在一个单元上'],
]

const steps = []
let cursor = 0
for (const call of calls) {
  if (cursor >= EXPECTED.length) {
    break
  }
  if (call.method === EXPECTED[cursor][0]) {
    steps.push(call)
    cursor += 1
  }
}

if (cursor < EXPECTED.length) {
  fail(
    `the loop stopped at step ${cursor + 1} ("${EXPECTED[cursor][0]}"); ` +
      `Core saw: ${calls.map((c) => c.method).join(' → ')}`,
  )
}

// 2. 内容：每一步都拿到了成功结果。
for (const [index, call] of steps.entries()) {
  const [method, needle, description] = EXPECTED[index]
  if (!call.response.includes(needle)) {
    fail(`${description}：${method} 返回的是 ${call.response.slice(0, 400)}`)
  }
}

// 3. 证据必须带真代码回来，不然"读代码"这一步是假的。
const evidence = steps.find((call) => call.method === 'evidence.read')
if (!/"content":"[^"]+/.test(evidence.response)) {
  fail('evidence.read 没带回源码内容，教学过程看不到真实代码')
}

// 4. 至少要教完一个单元、并且走到下一个单元（模型多教几个单元不算错）。
const completed = calls.filter(
  (call) => call.method === 'unit.complete' && call.response.includes('"status":"completed"'),
)
if (completed.length < 1) {
  fail('一个单元都没完成')
}

console.log(`\nCore saw ${calls.length} calls; the model drove the full loop:`)
for (const call of calls) {
  console.log(`  ${call.method}`)
}
console.log(
  `\n完成 ${completed.length} 个单元。` +
    'tutor-loop-smoke: 模型自己走完了 scan → map → unit → evidence → question → answer → evaluation → complete → 下一个单元',
)
