// Repo Tutor 的 DSH host 插件。
//
// 这一层只做宿主相关的事：spawn Core、把工具调用转发成 JSON-RPC、卸载时关掉 Core。
// 教学状态机、判分、证据预算、Question 契约全在 C++ Core 里，这里一行都不写。
// 唯一算"内容"的东西是工具描述和阻断提示的措辞——那是给模型看的说明书。

import { CoreClient } from './core-client.mjs'

export const name = 'repo-tutor-dsh'
export const inject = ['tools']

// Core 返回的 blocked 是正常业务结果，不是工具失败。
// 这里只把 reason 翻译成一句"下一步该干嘛"，状态判断依然在 Core。
const BLOCKED_HINTS = {
  NO_SESSION: '会话还没建起来，先调 tutor_status。',
  TOPIC_LOCKED: '当前单元没完成。用 tutor_complete_unit 收尾，或者继续教这个单元。',
  UNKNOWN_UNIT: '这个 unitId 不在 LearningMap 里，用 tutor_status 看有哪些单元。',
  UNIT_NOT_OPEN: '先 tutor_open_unit 打开这个单元。',
  MISSING_UNIT_ID: '要带上 unitId。',
  ESCAPE: '路径必须是仓库内的相对路径，不能跑出仓库根。',
  FILE_NOT_FOUND: '这个文件不存在，对照 tutor_scan_repository 的文件清单。',
  NOT_A_FILE: '这是个目录，不是文件。',
  NO_ROOT: '会话还没有仓库根，先跑 tutor_scan_repository。',
  MISSING_ROOT: '给 root，或者让会话有一个仓库根。',
  ROOT_NOT_READABLE: '这个根路径不存在或读不了。',
  MISSING_PATH: '要带上仓库内的相对路径。',
  EMPTY_LEARNING_MAP: '至少提一个单元。',
  DUPLICATE_UNIT_ID: '单元 id 不能重复。',
  UNIT_MISSING_ID: '每个单元都要有 id。',
  UNIT_MISSING_COGNITIVE_GOAL: '每个单元都要有一个说得清的 cognitiveGoal。',
  NO_QUESTION: '先 tutor_question_create 出题。',
  UNKNOWN_QUESTION: '用 tutor_question_create 返回的那个 questionId。',
  EMPTY_ANSWER: '回答是空的。',
  MISSING_PREMISE: '出题要有 premise。',
  NOT_DEEPER: 'Depth 只能往更深处走：d1_overview < d2_working < d3_implementation < d4_forensic。',
  EMPTY: '已经在主线上，没有可以返回的层。',
}

const textBlock = (value) => [{ type: 'text', text: JSON.stringify(value) }]

// 通用渲染：blocked 结果翻译成人话，其它原样给 JSON。
function render(_args, value) {
  if (value !== null && typeof value === 'object' && value.status === 'blocked') {
    const hint = BLOCKED_HINTS[value.reason]
    return [{ type: 'text', text: `BLOCKED ${value.reason}${hint === undefined ? '' : ` — ${hint}`}` }]
  }
  return textBlock(value)
}

// 证据要单独渲染：代码是给人读的，塞进 JSON 字符串里全是 \n，白瞎。
function renderEvidence(args, value) {
  if (value === null || typeof value !== 'object' || value.status === 'blocked') {
    return render(args, value)
  }
  const header =
    `${value.path}:${value.lineStart}-${value.lineEnd}（共 ${value.totalLines} 行）` +
    ` · 已读 ${value.filesRead} 个文件 / ${value.ledgerSize} 条证据` +
    (value.truncated ? ' · 已被字节上限截断，需要的话再读下一段' : '')
  return [{ type: 'text', text: `${header}\n\n${value.content}` }]
}

const DEPTHS = ['d1_overview', 'd2_working', 'd3_implementation', 'd4_forensic']

const QUESTION_TYPES = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'fill_in',
  'open_answer',
  'execution_trace',
  'debugging',
  'code_change_prediction',
  'architecture_design',
]

// 教学 prompt。只加一小节：什么时候用、循环长什么样、Core 拦什么。
// 具体的状态转移由 Core 兜底，这里不重复。
const GUIDANCE = `## Repo Tutor

You are also a repository tutor. When the user wants to understand an unfamiliar codebase — get oriented, learn how a mechanism works, be able to debug or change it — run the tutor loop through the tutor_* tools. A written summary does not build a mental model; guided reading does.

The loop:

1. \`tutor_status\`, then \`tutor_scan_repository\`.
2. \`tutor_propose_learning_map\` — split the repo into Learning Units, one cognitive goal each.
3. Confirm the map and where to start with the learner BEFORE opening a unit.
4. Per unit: \`tutor_open_unit\` → \`tutor_evidence_read\` with a rationale → teach → optionally check → \`tutor_complete_unit\`.

**Short turns, one unit at a time.** A teaching message is a conversation turn, not a chapter: a couple of short paragraphs plus the 5–25 lines of code that carry the point, and stay under roughly 350 words unless the learner asks for more. Never cover two units in one message, never dump everything you found, never open with a tour of the whole repository. Read the function or region you are about to explain, not whole files. Let the learner read and react; a unit can take several messages, so send more messages instead of writing one long one.

**Teach before you mark it done.** \`tutor_complete_unit\` closes a unit the learner has already seen. Never call it in the same turn as your evidence reads, and never before the lesson has actually reached the user. Then stop and let them respond — do not roll straight into the next unit unless they asked you to keep going.

**Ask with the question card when it exists.** Use \`ask_user_question\` to confirm the learning map or the starting point, and to pose a comprehension check — that way the learner gets a real input box instead of a question buried at the end of prose. Pass their answer verbatim to \`tutor_answer_submit\`, then judge it with \`tutor_evaluation_record\` against the frozen snapshot it returns. If that tool is not available, ask in your message and wait.

**Evidence goes through the Core.** \`tutor_evidence_read\` is the only way to look at repository content for teaching: it is what the Evidence Budget, the frozen question snapshot and the review trail are built on. Do not use the read, glob, grep or shell tools for repository contents — for orientation you have the map from \`tutor_scan_repository\`. Every read needs a rationale naming the cognitive goal it serves.

The Core enforces these, and a blocked result tells you which one you hit:
- One Learning Unit = one cognitive goal.
- Topic Lock: finish the open unit before opening another.
- Every evidence read must serve the open unit's goal and carry a rationale.
- Evaluation Before Exploration: judge an answer only with the evidence frozen at question time.
- Depth only moves deeper (\`tutor_depth_push\`), then returns (\`tutor_depth_pop\`).

Teach in the user's language. Quote the real code you read; never summarise a file you have not read through \`tutor_evidence_read\`.`

// `/tutor` 的输出：给人看的，不是给模型看的 JSON。
function formatStatus(state) {
  if (state === null || typeof state !== 'object' || state.status === 'blocked') {
    return `Repo Tutor: ${state?.reason ?? 'no session yet'}`
  }
  const lines = [
    `Repo Tutor · ${state.root === '' ? '（未确定仓库根）' : state.root}`,
    `coverage ${state.coverage} · depth ${state.currentDepth}` +
      ` · 证据 ${state.filesRead} 个文件 / ${state.ledgerSize} 条` +
      (state.openQuestionId === null ? '' : ` · 未结题目 ${state.openQuestionId}`),
  ]

  if (state.units.length === 0) {
    lines.push('还没有 LearningMap。')
    return lines.join('\n')
  }

  lines.push('')
  for (const [index, unit] of state.units.entries()) {
    const marker = unit.id === state.currentUnitId ? '→' : ' '
    lines.push(`${marker} ${index + 1}. [${unit.status}] ${unit.id} — ${unit.cognitiveGoal}`)
  }
  return lines.join('\n')
}

export function apply(ctx) {
  const exePath = process.env.REPO_TUTOR_CORE
  if (exePath === undefined || exePath === '') {
    throw new Error('repo-tutor-dsh: REPO_TUTOR_CORE must point at the repo-tutor-core executable')
  }

  // 一个仓库根一份 Core。同一个仓库的两个对话共享同一份学习状态，
  // 不同仓库各教各的，不会互相把根目录改来改去。
  const cores = new Map()
  ctx.effect(() => () => {
    for (const { client } of cores.values()) {
      client.close()
    }
    cores.clear()
  })

  // 仓库根来自这条调用所属会话的工作目录，不是宿主进程的 cwd：
  // DSH Web 的一个会话可以有自己的 workspace，两者不一样。
  function rootOf(exec) {
    const override = process.env.REPO_TUTOR_ROOT
    if (override !== undefined && override !== '') {
      return override
    }
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') {
      return cwd
    }
    return process.cwd()
  }

  function coreFor(root) {
    let entry = cores.get(root)
    if (entry === undefined) {
      const client = new CoreClient(exePath, {
        onStderr: (line) => console.log(`[repo-tutor] ${line}`),
      })
      const ready = (async () => {
        await client.request('protocol.negotiate')
        await client.request('session.start', { coverage: 'core_path', root })
      })()
      entry = { client, ready }
      cores.set(root, entry)
    }
    return entry
  }

  async function call(exec, method, params = {}) {
    const root = rootOf(exec)
    const { client, ready } = coreFor(root)
    try {
      await ready
    } catch (error) {
      // 起会话失败就把这半截扔掉，下一次调用重新来过。
      cores.delete(root)
      throw error
    }
    return client.request(method, params)
  }

  // 每个工具都是一次协议转发，所以统一在这里接线，别复制粘贴十遍。
  function registerTool(spec) {
    ctx.tools.register({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: 'object' },
        render: spec.render ?? render,
      },
      async execute(args, exec) {
        return call(exec, spec.method, spec.params === undefined ? {} : spec.params(args))
      },
    })
  }

  // ── 看状态 ───────────────────────────────────────────────────────────────

  registerTool({
    name: 'tutor_status',
    method: 'session.get',
    description:
      'Read the Repo Tutor session state: repository root, coverage, current depth, every Learning Unit with its status, the current unit, how many files have been read as evidence, and whether a question is open. Call this first, and again whenever you lose track of where the lesson stands.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  })

  // ── Recon + Learning Map ────────────────────────────────────────────────

  registerTool({
    name: 'tutor_scan_repository',
    method: 'repository.scan',
    params: (args) => (args.root === undefined ? {} : { root: args.root }),
    description:
      'Scan the repository and get the Repository Map: file list (capped, see `truncated`), language distribution and top-level directories. Do this once when the session starts. It reads structure only, not file contents.',
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Absolute path to the repository. Defaults to the session workspace.',
        },
      },
      additionalProperties: false,
    },
  })

  registerTool({
    name: 'tutor_propose_learning_map',
    method: 'learning_map.propose',
    params: (args) => ({ units: args.units }),
    description:
      'Propose the LearningMap that Core will own. Each unit is ONE cognitive goal — a mechanism the learner should end up able to explain, debug or change — not a file and not a chapter title. Keep the map short: a handful of units the learner can actually finish beats an exhaustive outline. Core rejects duplicate ids and units without a concrete cognitiveGoal. Replaces any previous map.',
    parameters: {
      type: 'object',
      properties: {
        units: {
          type: 'array',
          description: 'Ordered learning units, roughly from the entry path outward.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id, e.g. "unit-1".' },
              cognitiveGoal: {
                type: 'string',
                description: 'What the learner will be able to explain after this unit.',
              },
            },
            required: ['id', 'cognitiveGoal'],
            additionalProperties: false,
          },
        },
      },
      required: ['units'],
      additionalProperties: false,
    },
  })

  // ── 单元推进 ─────────────────────────────────────────────────────────────

  registerTool({
    name: 'tutor_open_unit',
    method: 'unit.open',
    params: (args) => ({ unitId: args.unitId }),
    description:
      'Open one Learning Unit and make it the current one. Topic Lock: Core refuses to switch away from an unfinished unit, so finish the current one with tutor_complete_unit before opening the next. Open a unit only when you are about to teach it in this turn.',
    parameters: {
      type: 'object',
      properties: {
        unitId: { type: 'string', description: 'The learning unit id to open.' },
      },
      required: ['unitId'],
      additionalProperties: false,
    },
  })

  registerTool({
    name: 'tutor_complete_unit',
    method: 'unit.complete',
    params: (args) => ({ unitId: args.unitId }),
    description:
      'Mark the current unit completed. Call it only after the lesson for this unit has actually reached the learner — not in the same turn as your evidence reads, and not before you have explained anything. Only the open unit can be completed.',
    parameters: {
      type: 'object',
      properties: {
        unitId: { type: 'string', description: 'The unit to complete (must be the open one).' },
      },
      required: ['unitId'],
      additionalProperties: false,
    },
  })

  // ── 证据 ────────────────────────────────────────────────────────────────

  registerTool({
    name: 'tutor_evidence_read',
    method: 'evidence.read',
    params: (args) => ({
      path: args.path,
      lineStart: args.lineStart ?? 0,
      lineEnd: args.lineEnd ?? 0,
      rationale: args.rationale ?? '',
    }),
    render: renderEvidence,
    description:
      'Read a slice of repository source AS EVIDENCE for the current unit, and return the actual code. This is the only sanctioned way to look at repository content: every read is recorded in the Evidence Budget with your rationale, and that ledger is what gets frozen when you ask a question. Read only what the current cognitive goal needs. Paths must be repo-relative; escaping the repo is rejected. Requires an open unit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path, e.g. "core/src/depth.cpp".' },
        lineStart: { type: 'number', description: '1-based first line. Omit to start at line 1.' },
        lineEnd: {
          type: 'number',
          description: '1-based last line, inclusive. Omit to read the default window.',
        },
        rationale: {
          type: 'string',
          description: 'Why the current cognitive goal needs this exact slice.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  })

  // ── 可选的验证环节 ────────────────────────────────────────────────────────

  registerTool({
    name: 'tutor_question_create',
    method: 'question.create',
    params: (args) => ({
      unitId: args.unitId,
      type: args.type ?? 'open_answer',
      premise: args.premise,
      evaluationMode: args.evaluationMode ?? 'model_assisted',
      evaluationCriteria: args.evaluationCriteria ?? '',
    }),
    description:
      'Freeze a comprehension check for the open unit, then pose it to the learner (with ask_user_question when that tool exists). The evidence read so far is snapshotted at this moment; the evaluation may only use that snapshot. Write a premise that stands on its own and criteria specific enough to judge fairly. One good question beats five easy ones.',
    parameters: {
      type: 'object',
      properties: {
        unitId: { type: 'string', description: 'The open unit this question belongs to.' },
        type: { type: 'string', enum: QUESTION_TYPES, description: 'Question kind.' },
        premise: {
          type: 'string',
          description: 'The situation the learner reasons about, e.g. "main calls run() first".',
        },
        evaluationMode: {
          type: 'string',
          enum: ['deterministic', 'model_assisted'],
          description: 'How the answer will be judged.',
        },
        evaluationCriteria: {
          type: 'string',
          description: 'What a correct answer must contain. Judge against this, not against taste.',
        },
      },
      required: ['unitId', 'premise'],
      additionalProperties: false,
    },
  })

  registerTool({
    name: 'tutor_answer_submit',
    method: 'answer.submit',
    params: (args) => ({ questionId: args.questionId, answer: args.answer }),
    description:
      "Submit the learner's answer verbatim. Returns the frozen question contract — premise, criteria and the exact evidence snapshot taken when the question was asked. Judge against that snapshot only: files read after the question are deliberately not in it (Evaluation Before Exploration).",
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string', description: 'Id returned by tutor_question_create.' },
        answer: { type: 'string', description: "The learner's answer, unedited." },
      },
      required: ['questionId', 'answer'],
      additionalProperties: false,
    },
  })

  registerTool({
    name: 'tutor_evaluation_record',
    method: 'evaluation.record',
    params: (args) => ({
      questionId: args.questionId,
      correct: args.correct ?? false,
      feedback: args.feedback ?? '',
      voided: args.voided ?? false,
    }),
    description:
      'Record your verdict after judging the answer against the frozen criteria and evidence. Be fair: correct when the core mechanism is there, not only when the wording matches. If the question itself was flawed, set voided=true and the verdict is discarded instead of blaming the learner.',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string', description: 'Id returned by tutor_question_create.' },
        correct: { type: 'boolean', description: 'Did the answer reach the cognitive goal?' },
        feedback: {
          type: 'string',
          description: 'What was right, what was missing, what to read again.',
        },
        voided: {
          type: 'boolean',
          description: 'true when the question itself was bad; the evaluation is discarded.',
        },
      },
      required: ['questionId'],
      additionalProperties: false,
    },
  })

  // ── Depth 下钻 ──────────────────────────────────────────────────────────

  registerTool({
    name: 'tutor_depth_push',
    method: 'depth.push',
    params: (args) => ({ depth: args.depth }),
    description:
      'Dive one level deeper into the current sub-topic. Depth order is d1_overview < d2_working < d3_implementation < d4_forensic; Core only accepts strictly deeper, so you cannot drift sideways. Come back with tutor_depth_pop.',
    parameters: {
      type: 'object',
      properties: {
        depth: { type: 'string', enum: DEPTHS, description: 'Target depth for this dive.' },
      },
      required: ['depth'],
      additionalProperties: false,
    },
  })

  registerTool({
    name: 'tutor_depth_pop',
    method: 'depth.pop',
    description:
      'Return one level toward the mainline after a dive. Blocks when already on the mainline.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  })

  // ── system prompt 小节 ──────────────────────────────────────────────────
  //
  // 用 ctx.inject 而不是 ctx.get：服务可能在插件 apply 之后才挂上来，
  // ctx.get 只查一次，查不到就永久错过（`/tutor` 命令就踩过这个坑）。

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'repo-tutor',
      order: 2450,
      interpolate: false,
      text: GUIDANCE,
    })
  })

  // ── /tutor 命令 ────────────────────────────────────────────────────────

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'tutor',
      description: 'Show the current Repo Tutor session state for this conversation.',
      async handler(invocation) {
        const exec = { agent: invocation.agent }
        try {
          return { kind: 'success', text: formatStatus(await call(exec, 'session.get')) }
        } catch (error) {
          return { kind: 'error', text: `/tutor failed: ${error.message}` }
        }
      },
    })
  })
}
