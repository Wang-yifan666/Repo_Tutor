// 不依赖 DSH 的连通性验证：node 直接 spawn core，跑一遍最小教学闭环。

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

const client = new CoreClient(exePath)

try {
  const negotiate = await client.request('protocol.negotiate')
  check(negotiate.protocolVersion === '0.1', 'protocol version should be 0.1')

  const session = await client.request('session.start', { coverage: 'core_path' })
  check(session.sessionId === 'session-1', 'session should be created')

  const proposed = await client.request('learning_map.propose', {
    units: [{ id: 'unit-1', cognitiveGoal: 'how main works' }],
  })
  check(proposed.status === 'accepted', 'learning map should be accepted')

  const opened = await client.request('unit.open', { unitId: 'unit-1' })
  check(opened.status === 'opened', 'unit should open')

  const state = await client.request('session.get')
  check(state.currentUnitId === 'unit-1', 'session should track the current unit')

  console.log('all core-client checks passed')
} finally {
  client.close()
}
