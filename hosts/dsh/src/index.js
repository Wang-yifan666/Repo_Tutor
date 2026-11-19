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

// 教学 prompt：只加一小节，讲清楚什么时候该用 Repo Tutor、循环长什么样。
// 具体状态转移由 Core 兜底，所以这里写短一点，别抢 DSH 自己的 prompt。
const GUIDANCE = `## Repo Tutor

You are also a repository tutor. When the user wants to understand an unfamiliar codebase — get oriented, learn how a mechanism works, be able to debug or change it — run the tutor loop through the tutor_* tools instead of writing a summary. Summaries do not build mental models.

The loop:

1. \`tutor_status\` — read the state first, always.
2. \`tutor_scan_repository\` — build the Repository Map.
3. \`tutor_propose_learning_map\` — split the repo into Learning Units, one cognitive goal each.
4. Per unit: \`tutor_open_unit\` → \`tutor_evidence_read\` with a rationale → teach the code you actually read → optionally \`tutor_question_create\` / \`tutor_answer_submit\` / \`tutor_evaluation_record\` → \`tutor_complete_unit\`.
5. \`tutor_depth_push\` / \`tutor_depth_pop\` when one mechanism deserves a dive.

The Core enforces these, and a blocked result tells you which one you hit:
- One Learning Unit = one cognitive goal.
- Topic Lock: finish the open unit before opening another.
- Every evidence read must serve the open unit's goal and carry a rationale.
- Evaluation Before Exploration: judge an answer only with the evidence frozen at question time.
- Depth only moves deeper, then returns to the mainline.

Teach in the user's language. Quote the real code you read; never summarise a file you have not read through \`tutor_evidence_read\`. Ask a question when you are unsure whether the mental model holds, not on a schedule. Close a unit when the learner can explain it back.`

export function apply(ctx) {
  const exePath = process.env.REPO_TUTOR_CORE
  if (exePath === undefined || exePath === '') {
    throw new Error('repo-tutor-dsh: REPO_TUTOR_CORE must point at the repo-tutor-core executable')
  }

  const client = new CoreClient(exePath, {
    onStderr: (line) => console.log(`[repo-tutor] ${line}`),
  })
  ctx.effect(() => () => client.close())

  // 会话的仓库根：宿主的工作目录就是用户的仓库。环境变量留给测试和特殊布局。
  const defaultRoot = () => process.env.REPO_TUTOR_ROOT ?? process.cwd()

  // 第一个工具调用时再建会话，避免 apply 里做异步初始化。
  let sessionReady = null
  function ensureSession() {
    if (sessionReady === null) {
      sessionReady = (async () => {
        await client.request('protocol.negotiate')
        await client.request('session.start', { coverage: 'core_path', root: defaultRoot() })
      })()
    }
    return sessionReady
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
      async execute(args) {
        await ensureSession()
        return client.request(spec.method, spec.params === undefined ? {} : spec.params(args))
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
          description: 'Absolute path to the repository. Defaults to the session root.',
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
      'Propose the LearningMap that Core will own. Each unit is ONE cognitive goal — a mechanism the learner should end up able to explain, debug or change — not a file and not a chapter title. Core rejects duplicate ids and units without a concrete cognitiveGoal. Replaces any previous map.',
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
      'Open one Learning Unit and make it the current one. Topic Lock: Core refuses to switch away from an unfinished unit, so finish the current one with tutor_complete_unit before opening the next.',
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
      'Mark the current unit completed, once the learner has the cognitive goal in hand. Only the open unit can be completed; afterwards you may open the next one.',
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
      'Read a slice of repository source AS EVIDENCE for the current unit, and return the actual code. Every read is recorded in the Evidence Budget with your rationale, and that ledger is what gets frozen when you ask a question — so read only what the current cognitive goal needs. Paths must be repo-relative; escaping the repo is rejected. Requires an open unit.',
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
      'Freeze a comprehension check for the open unit. The evidence read so far is snapshotted at this moment; the evaluation may only use that snapshot. Write a premise that stands on its own and criteria specific enough to judge fairly. A question is a verification mechanism, not a required stage — one good open question beats five multiple-choice ones.',
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

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'repo-tutor',
      order: 2450,
      interpolate: false,
      text: GUIDANCE,
    })
  }
}
