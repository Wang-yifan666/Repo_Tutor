# Repo Tutor 的 DSH Adapter

DSH 是 Repo Tutor 的第一个 Host。这一层只做宿主相关的事：spawn C++ Core、
把调用转发成 JSON-RPC、管理 Core 生命周期。判分、状态机、证据预算、
Question 契约全在 `core/` 里。

## 结构

- `src/core-client.mjs`：spawn `repo-tutor-core`，逐行收发 JSON-RPC。
- `src/index.js`：Cordis 插件，注册 3 个工具 + `/tutor` 命令。
- `test/client-smoke.mjs`：不依赖 DSH 的连通性测试。
- `cordis.patch.yml`：装进 profile 用的 bundle 层。
- `overlay.local.yml`：本地开发用 `--patch` overlay（绝对路径，已 gitignore）。

## 本地跑

```sh
# 先构建 core，再让 DSH 加载插件
$env:REPO_TUTOR_CORE = "<repo>/build/dev-mingw/apps/repo-tutor-core/repo-tutor-core.exe"
pnpm dsh web --patch hosts/dsh/overlay.local.yml
```

单独验证 Core 连接（不需要 DSH）：

```sh
node hosts/dsh/test/client-smoke.mjs "<repo>/build/dev-mingw/apps/repo-tutor-core/repo-tutor-core.exe"
```

## 当前能力

- 工具：`tutor_status`、`tutor_open_unit`、`tutor_evidence_read`
- 命令：`/tutor` 显示当前会话状态（web profile；headless 没有 commands，自动跳过）

## 模型驱动验证（已跑通）

headless profile 可以直接验证"模型 → 工具 → Core"：

```sh
$env:REPO_TUTOR_CORE = "<repo>/build/dev-mingw/apps/repo-tutor-core/repo-tutor-core.exe"
pnpm dsh --profile headless --patch "<repo>/hosts/dsh/overlay.local.yml" \
  "Call the tutor_status tool and print its exact raw output."
```

模型会调用 `tutor_status`，拿回 Core 的真实状态：

```json
{"sessionId":"session-1","coverage":"core_path","currentDepth":"d2_working","units":[],"currentUnitId":null}
```

commands 是可选能力：headless 没有它，插件用 `ctx.get('commands')` 探测而不是写进
`inject`，所以同一份插件在 headless 和 web 下都能加载。

## 还没做：Conversation Node

完整的 DSH Web UI（`ConversationNodeDefinition`）没有做，有两个实际障碍：

1. **session event 的 ignorable 机制**：out-of-tree 插件的事件类型不在
   `KNOWN_SESSION_EVENT_TYPES` 里，而 `Session.append()` 不会设置 `ignorable`
   标记，外部插件用 append 发的自定义事件会被持久化读路径拒绝。
2. **client bundle 构建**：`dsh.client` 声明需要构建出 `./client` bundle，
   依赖 DSH 内部的 tsdown preset；out-of-tree 插件没有现成的构建路径。

在解决这两点之前，`/tutor` 命令和 tool 输出就是当前的最小 UI surface。

## 已知风险

- 强杀 DSH 进程时插件 disposer 不执行，Core 会残留；目前靠 Core 在 stdin
  EOF 时自行退出兜底。
