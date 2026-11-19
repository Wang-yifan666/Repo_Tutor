// 不依赖 DSH 的连通性验证：node 直接 spawn core，把协议完整走一遍。
// 这里验证的是"adapter ↔ Core 的通道和协议语义"，不涉及模型。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CoreClient } from '../src/core-client.mjs'

const exePath = process.argv[2]

function check(condition, message) {
  if (!condition) {
    console.error(`FAILED: ${message}`)
    process.exit(1)
  }
}

if (exePath === undefined) {
  console.error('usage: node client-smoke.mjs <repo-tutor-core-exe>')
  process.exit(2)
}

// 造一个最小仓库，让 scan 和 evidence.read 有真东西可读。
const root = mkdtempSync(join(tmpdir(), 'repo-tutor-client-'))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'src', 'main.cpp'), 'int main()\n{\n\treturn 0;\n}\n')
writeFileSync(join(root, 'README.md'), '# demo\n')

const client = new CoreClient(exePath)

try {
  const negotiate = await client.request('protocol.negotiate')
  check(negotiate.protocolVersion === '0.1', 'protocol version should be 0.1')

  const session = await client.request('session.start', { coverage: 'core_path', root })
  check(session.sessionId === 'session-1', 'session should be created')
  check(session.root.length > 0, 'session should remember the repository root')

  const scan = await client.request('repository.scan', {})
  check(scan.status === 'scanned', 'scan without an explicit root should use the session root')
  check(scan.fileCount === 2, 'scan should find the two fixture files')
  check(scan.languages.some((entry) => entry.language === 'cpp'), 'scan should report languages')
  check(scan.directories.includes('src'), 'scan should report top-level directories')

  const proposed = await client.request('learning_map.propose', {
    units: [
      { id: 'unit-1', cognitiveGoal: 'how main works' },
      { id: 'unit-2', cognitiveGoal: 'what the readme promises' },
    ],
  })
  check(proposed.status === 'accepted', 'learning map should be accepted')
  check(proposed.unitCount === 2, 'learning map should keep both units')

  // 没开单元就读证据应该被拦：证据要服务于当前认知目标。
  const noUnit = await client.request('evidence.read', { path: 'src/main.cpp', rationale: 'x' })
  check(noUnit.reason === 'UNIT_NOT_OPEN', 'evidence read should require an open unit')

  const opened = await client.request('unit.open', { unitId: 'unit-1' })
  check(opened.status === 'opened', 'unit should open')

  const locked = await client.request('unit.open', { unitId: 'unit-2' })
  check(locked.reason === 'TOPIC_LOCKED', 'topic lock should block switching away')

  const evidence = await client.request('evidence.read', {
    path: 'src/main.cpp',
    lineStart: 1,
    lineEnd: 2,
    rationale: 'the entry point',
  })
  check(evidence.status === 'recorded', 'evidence read should be recorded')
  check(evidence.content.includes('int main()'), 'evidence read should return the source')
  check(evidence.totalLines === 4, 'evidence read should report the file length')

  const escaped = await client.request('evidence.read', { path: '../escape.txt', rationale: 'x' })
  check(escaped.reason === 'ESCAPE', 'escaping the repository should be blocked')

  const question = await client.request('question.create', {
    unitId: 'unit-1',
    type: 'open_answer',
    premise: 'main returns a value.',
    evaluationMode: 'model_assisted',
    evaluationCriteria: 'mentions the return value',
  })
  check(question.status === 'created', 'question should be created')
  check(question.evidenceCount === 1, 'question should freeze the evidence read so far')

  // 提问之后又读了一份：评价时不许用它。
  await client.request('evidence.read', { path: 'README.md', rationale: 'after the question' })

  const answer = await client.request('answer.submit', {
    questionId: question.questionId,
    answer: 'it returns 0',
  })
  check(answer.evidenceCount === 1, 'answer context must use only the frozen snapshot')
  check(
    answer.evidence.every((entry) => entry.path !== 'README.md'),
    'answer context must not leak post-question evidence',
  )

  const evaluation = await client.request('evaluation.record', {
    questionId: question.questionId,
    correct: true,
    feedback: 'right',
  })
  check(evaluation.status === 'recorded', 'evaluation should be recorded')
  check(evaluation.correct === true, 'evaluation should keep the verdict')

  const pushed = await client.request('depth.push', { depth: 'd3_implementation' })
  check(pushed.currentDepth === 'd3_implementation', 'depth push should go deeper')
  const popped = await client.request('depth.pop')
  check(popped.currentDepth === 'd2_working', 'depth pop should return to the mainline')

  const completed = await client.request('unit.complete', { unitId: 'unit-1' })
  check(completed.status === 'completed', 'unit should complete')

  const reopened = await client.request('unit.open', { unitId: 'unit-2' })
  check(reopened.status === 'opened', 'switching after completion should be allowed')

  const state = await client.request('session.get')
  check(state.currentUnitId === 'unit-2', 'session should track the current unit')
  check(state.filesRead === 2, 'state should report the evidence ledger')
  check(state.openQuestionId === null, 'a new unit should not inherit the old question')

  console.log('all core-client checks passed')
} finally {
  client.close()
  rmSync(root, { recursive: true, force: true })
}
