# Repo Tutor 的 DSH Adapter

DSH 是 Repo Tutor 的第一个 Host。这一层只做宿主相关的事：spawn C++ Core、
把调用转发成 JSON-RPC、管理 Core 生命周期。判分、状态机、证据预算、
Question 契约全在 `core/` 里。

## 结构

- `src/core-client.mjs`：spawn `repo-tutor-core`，逐行收发 JSON-RPC。
- `src/index.js`：Cordis 插件，注册 11 个工具 + 教学 prompt 小节 + `/tutor` 命令。
- `test/client-smoke.mjs`：不依赖 DSH 的协议走查（scan → map → unit → evidence →
  问题 → 评价 → 完成 → 下一个单元）。
- `cordis.patch.yml`：装进 profile 用的 bundle 层。
- `overlay.local.yml`：本地开发用 `--patch` overlay（绝对路径，已 gitignore）。

## 先试试

一条命令起一个带插件的 DSH Web，你要读的仓库同时是 workspace 和 tutor 的仓库根：

```sh
$env:DSH_HARNESS = "D:\DSH\deepseek-harness"
node scripts/try.mjs                    # 读本仓库
node scripts/try.mjs D:\path\to\repo    # 读别的仓库
```

它会打印带 token 的地址并在浏览器里打开。进去说一句「带我读懂这个仓库」就行。

为什么不用 `pnpm dsh web`：`pnpm dsh` 必须在 DSH checkout 里跑，cwd 就是 harness，
tutor 的仓库根对不上。`try.mjs` 用绝对路径调 CLI、把 cwd 留给目标仓库，
再顺手把 tsx 的 tsconfig 钉回 checkout（不钉会解析错 `@deepseek-ai/cordis`）。

## 本地跑（手动）

```sh
# 先构建 core，再让 DSH 加载插件
$env:REPO_TUTOR_CORE = "<repo>/build/dev-mingw/apps/repo-tutor-core/repo-tutor-core.exe"
pnpm dsh web --patch hosts/dsh/overlay.local.yml
```

单独验证协议通道（不需要 DSH）：

```sh
node hosts/dsh/test/client-smoke.mjs "<repo>/build/dev-mingw/apps/repo-tutor-core/repo-tutor-core.exe"
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `REPO_TUTOR_CORE` | 必填。`repo-tutor-core` 可执行文件路径。 |
| `REPO_TUTOR_ROOT` | 会话的仓库根。不设就用宿主进程的 `process.cwd()`。 |
| `REPO_TUTOR_TRACE` | 非空且非 `0` 时，Core 把每条请求和响应摘一行到 stderr。调试和验证用。 |

## 工具

| 工具 | 协议方法 | Core 会拦什么 |
|---|---|---|
| `tutor_status` | `session.get` | — |
| `tutor_scan_repository` | `repository.scan` | 根目录不存在 |
| `tutor_propose_learning_map` | `learning_map.propose` | 空 map、id 重复、缺 cognitiveGoal |
| `tutor_open_unit` | `unit.open` | Topic Lock：当前单元没完成不许切走 |
| `tutor_complete_unit` | `unit.complete` | 只能结当前单元 |
| `tutor_evidence_read` | `evidence.read` | 没开单元、路径逃逸、文件不存在 |
| `tutor_question_create` | `question.create` | 单元没开、缺 premise |
| `tutor_answer_submit` | `answer.submit` | 没有题目、questionId 对不上 |
| `tutor_evaluation_record` | `evaluation.record` | 没有题目、questionId 对不上 |
| `tutor_depth_push` | `depth.push` | 只能往更深处走 |
| `tutor_depth_pop` | `depth.pop` | 已经在主线就没什么可返回 |

`tutor_evidence_read` 会把**真实代码**带回来（Core 读文件、做路径检查、按行裁剪、
6000 字节封顶），不是只记一笔账。证据台账冻结在 `question.create` 那一刻，
`answer.submit` 返回的评估上下文只包含那份快照。

`/tutor` 命令显示当前会话状态（web profile；headless 没有 commands，自动跳过）。

## 教学 prompt

插件往 system prompt 里加一节 `repo-tutor`（order 2450），内容在 `src/index.js`
的 `GUIDANCE` 里：什么该用 tutor 循环、循环长什么样、Core 会拦哪五条。
服务不存在时（比如被裁剪过的 profile）自动跳过，不写进 `inject`。

## 验证

**单点：** 模型能调到 Core。

```sh
$env:DSH_HARNESS = "D:\DSH\deepseek-harness"
node scripts/model-smoke.mjs
```

**全流程：** 模型自己把完整教学闭环跑完。

```sh
$env:DSH_HARNESS = "D:\DSH\deepseek-harness"
node scripts/tutor-loop-smoke.mjs
```

它建一个临时小仓库，让模型走 scan → propose map → open unit → evidence →
question → answer → evaluation → complete → 下一个单元。判定不靠模型自己的汇报：
脚本读 `REPO_TUTOR_TRACE=1` 打出的协议轨迹，按顺序和内容核对 Core 实际收到了什么。
完整日志写在 `build/tutor-loop-smoke.log`。

## 还没做：Conversation Node

完整的 DSH Web UI（`ConversationNodeDefinition`）没有做，有两个实际障碍：

1. **session event 的 ignorable 机制**：out-of-tree 插件的事件类型不在
   `KNOWN_SESSION_EVENT_TYPES` 里，而 `Session.append()` 不会设置 `ignorable`
   标记，外部插件用 append 发的自定义事件会被持久化读路径拒绝。
2. **client bundle 构建**：`dsh.client` 声明需要构建出 `./client` bundle，
   依赖 DSH 内部的 tsdown preset；out-of-tree 插件没有现成的构建路径。

在解决这两点之前，工具输出和 `/tutor` 命令就是当前的 UI surface。

## 已知风险

- 强杀 DSH 进程时插件 disposer 不执行，Core 会残留；目前靠 Core 在 stdin
  EOF 时自行退出兜底。
- Core 是按插件实例唯一的：一个 DSH 进程里多个 agent 共用一份会话状态。
