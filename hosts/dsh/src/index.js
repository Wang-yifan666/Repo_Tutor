// Repo Tutor 的 DSH host 插件。
// 只做三件事：spawn Core、把工具调用转发成 JSON-RPC、卸载时关掉 Core。
// 判分、状态机、证据预算都不在这里，全在 C++ Core 里。

import { CoreClient } from './core-client.mjs'

export const name = 'repo-tutor-dsh'
export const inject = ['tools', 'commands']

const textBlock = (value) => [{ type: 'text', text: JSON.stringify(value) }]

export function apply(ctx) {
  const exePath = process.env.REPO_TUTOR_CORE
  if (exePath === undefined || exePath === '') {
    throw new Error('repo-tutor-dsh: REPO_TUTOR_CORE must point at the repo-tutor-core executable')
  }

  const client = new CoreClient(exePath, {
    onStderr: (text) => console.log(`[repo-tutor] ${text.trimEnd()}`),
  })
  ctx.effect(() => () => client.close())

  // 第一个工具调用时再建会话，避免 apply 里做异步初始化。
  let sessionReady = null
  function ensureSession() {
    if (sessionReady === null) {
      sessionReady = (async () => {
        await client.request('protocol.negotiate')
        await client.request('session.start', { coverage: 'core_path' })
      })()
    }
    return sessionReady
  }

  ctx.tools.register({
    name: 'tutor_status',
    description: 'Read the current Repo Tutor session state (coverage, depth, units, current unit).',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute() {
      await ensureSession()
      return client.request('session.get')
    },
  })

  ctx.tools.register({
    name: 'tutor_open_unit',
    description: 'Open one Learning Unit. Topic Lock blocks switching away from an unfinished unit.',
    parameters: {
      type: 'object',
      properties: {
        unitId: { type: 'string', description: 'The learning unit id to open.' },
      },
      required: ['unitId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      await ensureSession()
      return client.request('unit.open', { unitId: args.unitId })
    },
  })

  ctx.tools.register({
    name: 'tutor_evidence_read',
    description: 'Read repository evidence through the Evidence Budget. Paths outside the repo are rejected.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path.' },
        lineStart: { type: 'number' },
        lineEnd: { type: 'number' },
        rationale: { type: 'string', description: 'Why this evidence is needed for the current cognitive goal.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      await ensureSession()
      return client.request('evidence.read', {
        path: args.path,
        lineStart: args.lineStart ?? 0,
        lineEnd: args.lineEnd ?? 0,
        rationale: args.rationale ?? '',
      })
    },
  })

  // 最小可替代 UI surface：在对话里用 /tutor 显示 core 状态。
  // 完整的 Conversation Node 受限于 out-of-tree client bundle 构建和
  // session event 的 ignorable 机制，见 hosts/dsh/README.md。
  ctx.commands.register({
    name: 'tutor',
    description: 'Show the current Repo Tutor session state.',
    async handler() {
      await ensureSession()
      const state = await client.request('session.get')
      return { kind: 'success', text: JSON.stringify(state, null, 2) }
    },
  })
}
