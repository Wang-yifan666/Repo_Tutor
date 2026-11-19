# repo-tutor-dsh

Repo Tutor 的 DSH 插件包：11 个 `tutor_*` 工具、一节教学 prompt、一个 `/tutor` 命令，
外加「导师模式」的 agent preset。

它**自身不含教学逻辑**。判分、状态机、证据预算、Question 契约都在 C++ Core
（`repo-tutor-core`）里，这一层只做三件事：spawn Core、把工具调用转发成 JSON-RPC、
卸载时关掉 Core。

## 你需要什么

| 需要 | 说明 |
|---|---|
| DSH | `engines.dsh` 声明的窗口内，当前验证于 `0.1.6-alpha.1` |
| Node | `^22.19.0 \|\| >=24.0.0`（跟 DSH 一致） |
| `repo-tutor-core` 可执行文件 | 本阶段**不随包分发**，得自己拿 |

`repo-tutor-core` 的解析顺序：

1. 插件行配置里的 `corePath`
2. `REPO_TUTOR_CORE` 环境变量
3. 源码 checkout 的构建产物（只在从仓库里直接跑时存在）

从 npm 装进来时 1 或 2 必须给一个，否则挂载时报 `repo-tutor-core not found`，
错误信息里会列出它找过的每一个路径。

## 装

```sh
# 作为 profile 的一层（推荐）
dsh plugin --profile web add repo-tutor-dsh

# 或者手动装进 profile
cd "$DSH_HOME/profiles/web" && pnpm add repo-tutor-dsh
```

包声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 之后它会被自动加进
`dsh.profile.bundles`，插件行随 profile 启动生效。启动前记得给 Core 路径：

```sh
REPO_TUTOR_CORE=/path/to/repo-tutor-core
```

## 导师模式（第五个模式）

DSH 自带四个模式（标准 / PTC / 极简 / 创造），都从"编码 Agent"出发。导师模式是第五个，
也是最窄的一个：**只教，不替你改**。选它，整段会话就是教学会话。

```sh
repo-tutor-install-preset                        # Core 走 REPO_TUTOR_CORE
repo-tutor-install-preset --core /path/to/core   # 把路径写进 preset
```

装进 `$DSH_HOME/.agent-presets/repo-tutor/`，重启 DSH 后在模式选择器里选「导师模式」。

安装器会把插件本体复制进 preset 目录（`plugin/src`、`plugin/policies`），行写成
`./plugin/src/index.js`。**故意不用包名**：DSH 解析 preset 行里的包名时，基准是
已安装的 harness，不是用户的 profile，装进 profile 的包它看不见；`./` 开头的名字
按 preset 自己的目录解析（Include 会改写 baseUrl），从 checkout 跑和从 npm 包跑都一样。

**改名不用重启，改行为要重启。** roster 每次调用都重读目录，所以显示名、说明立刻生效；
但 preset 一旦被某个会话挂载过，这份组合就钉在那个进程里直到进程退出
（DSH 的 standing mount 语义）。改完 preset 或插件代码要重启一次 DSH 进程。

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

导师模式另外有三条收紧：`alwaysOn`（prompt 变成"这个会话就是教学"）、
`blockBypassTools`（把宿主全局注册的读文件/执行命令/上网/派子代理类工具从这个 agent 上摘掉）、
没有 fs / shell / web / 子代理行的组合。它们清不掉无关的全局插件（比如 CAD）——
DSH 的 `tools.restrict()` 只认具体工具名。

## 教学 prompt

正文在 `policies/tutor-prompt.md`，**每次组装现读**，所以改措辞不用重启 DSH。
行配置的 `promptPath` 可以指到别处。文件读不到时退到一份最小规则并打日志。

## 环境变量

| 变量 | 作用 |
|---|---|
| `REPO_TUTOR_CORE` | Core 可执行文件路径（从 npm 装时的必须项之一） |
| `REPO_TUTOR_ROOT` | 覆盖仓库根。不设就跟着会话自己的工作目录走 |
| `REPO_TUTOR_TRACE` | 非空且非 `0` 时，Core 把每条请求/响应摘一行到 stderr |

## 包里有什么

```
src/index.js                插件本体（工具 / prompt 小节 / /tutor 命令）
src/core-client.mjs         spawn core + 逐行 JSON-RPC
policies/tutor-prompt.md    教学 prompt 正文
preset/                     导师模式的组合模板
scripts/install-preset.mjs  导师模式安装器（bin: repo-tutor-install-preset）
scripts/verify-package.mjs  发布前自检（npm pack + 解包 + 接线断言）
cordis.patch.yml            bundle 层：插一行插件
```

## 验证

包内自检（不依赖 DSH 环境，会真的 `npm pack` 再解包检查）：

```sh
npm run verify
```

完整验证（协议走查、插件接线、模型闭环）在仓库里跑：
<https://github.com/Wang-yifan666/Repo_Tutor#readme>

## 还没做：Conversation Node

完整的 DSH Web UI（`ConversationNodeDefinition`）没做，有两个实际障碍：

1. **session event 的 ignorable 机制**：out-of-tree 插件的事件类型不在
   `KNOWN_SESSION_EVENT_TYPES` 里，而 `Session.append()` 不会设置 `ignorable`
   标记，外部插件用 append 发的自定义事件会被持久化读路径拒绝。
2. **client bundle 构建**：`dsh.client` 声明需要构建出 `./client` bundle，
   依赖 DSH 内部的 tsdown preset；out-of-tree 插件没有现成的构建路径。

在那之前，工具输出和 `/tutor` 命令就是 UI surface。

## 生命周期与已知风险

- Core 按**仓库根**一份：同一仓库的两个对话共享学习状态，不同仓库各用各的。
  插件卸载时全部关掉。
- 仓库根来自这条调用所属会话的工作目录（`agent.session.header.cwd`），不是宿主进程 cwd。
- Core 在 stdin EOF 时自行退出，所以强杀宿主不会留下孤儿进程（实测有效，
  但没有兜底以外的保证）。

MIT License.
