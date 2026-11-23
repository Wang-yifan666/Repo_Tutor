# repo-tutor-dsh

Repo Tutor 的 DSH 插件包：11 个 `tutor_*` 工具、一节教学 prompt、一个 `/tutor` 命令，
外加「导师模式」的 agent preset。

它**自身不含教学逻辑**。判分、状态机、证据预算、Question 契约都在 C++ Core
（`repo-tutor-core`）里，这一层只做三件事：spawn Core、把工具调用转发成 JSON-RPC、
卸载时关掉 Core。

当前版本 `0.1.0-rc.1`，**预发布**：只挂在 `next` 标签上，安装要写 `@next`。

## 支持矩阵

只列已经验证过的组合。没验证的写在下一节「已知限制」里，别指望它。

| 平台 | Core 二进制 | 在 DSH 里端到端跑过 | 平台包 |
|---|---|---|---|
| Windows x64 | 通过（Windows 11，ctest 9/9，`objdump -p` 只剩 `KERNEL32.dll` / `msvcrt.dll`） | **通过**：真实模型、Preset-only、完整教学回合（status → scan → propose_map → open_unit → evidence_read → complete_unit） | `@repo-tutor/core-win32-x64` |
| Linux x64 | 通过（WSL2 Ubuntu 24.04，ctest 9/9，`ldd` 只剩 libc/ld/vdso，client-smoke 走完协议） | **没有**：DSH 在 Linux 上没装过 | `@repo-tutor/core-linux-x64` |
| macOS arm64 | 没有 | 没有 | 不发 |

DSH 版本：**`0.1.6-alpha.1` 与 `0.2.3-alpha.2`** 上跑过整轮教学。两者的 preset 机制不同，
安装方式也不同（见「装」）；`engines.dsh` 写的是 `>=0.1.6-alpha.1 <0.2.0 || >=0.2.3-alpha.2 <0.3.0`，
中间的 0.1.7 / 0.2.0–0.2.2 没测。Node：实测 `22.19.0`，
`engines.node` 是 `^22.19.0 || >=24.0.0`。

## 你需要什么

| 需要 | 说明 |
|---|---|
| DSH | `0.1.6-alpha.1` 或 `0.2.3-alpha.2`（两者都验过；中间的版本没测） |
| Node | `^22.19.0 \|\| >=24.0.0`（跟 DSH 一致） |
| `repo-tutor-core` | 由平台包提供；只有 Windows x64 / Linux x64 有 |

`repo-tutor-core` 的解析顺序：

1. 插件行配置里的 `corePath`（preset 里写成相对路径，按插件自身目录解析）
2. `REPO_TUTOR_CORE` 环境变量（空字符串会被忽略，等于没设）
3. **自身 `optionalDependencies` 里当前平台的包**（Bundle 模式）
4. 源码 checkout 的构建产物（只对开发有用）

平台包是精确版本锁定的：`repo-tutor-dsh@0.1.0-rc.1` 只认
`@repo-tutor/core-<platform>-<arch>@0.1.0-rc.1`。装不上（`--omit=optional`、
平台不匹配、registry 缺包）时会报一条把四条出路都列出来的错误。

## 装

**预发布版本必须带 `@next`**：`0.1.0-rc.1` 不在 `latest` 标签上，不写标签的话 npm 会报「没有匹配版本」。

### DSH 0.2 及以后（推荐）

一条命令，插件和「导师模式」一起到位：

```sh
dsh plugin --profile web add repo-tutor-dsh@next
```

包的 `cordis.patch.yml` 声明了两行：host 插件行（11 个工具、教学 prompt、`/tutor` 命令，
标准模式下也能调），以及 `preset-repo-tutor`（`@deepseek-ai/dsh-agent-preset` 行，id 是
`repo-tutor`）。平台包作为 optionalDependency 一起装下来，**不需要设 `REPO_TUTOR_CORE`**。
装完重启 DSH 进程，模式选择器里就有「导师模式」。

preset 里那条插件行写的是**包名** `repo-tutor-dsh`：0.2 的 preset 行按「声明它的组合」的
解析基准解析，也就是用户 profile 的 `node_modules`，包名看得见。别改成相对路径 —— 那会指向
profile 目录本身。

### DSH 0.1.x

那个版本的 preset 是目录式的，要跑安装器：

```sh
npx repo-tutor-dsh@next --core /path/to/repo-tutor-core   # 用户自己管 Core
npx repo-tutor-dsh@next                                   # 或者：把平台包里的 Core 复制进 preset
```

不带 `--core` 时，安装器把平台包里的二进制**复制**到 `<preset>/bin/`，行里写相对路径
`../bin/repo-tutor-core.exe`。这样做是因为 npx / npm 缓存随时会被清掉，把缓存里的绝对路径
写进持久化配置迟早失效；复制之后 preset 目录能整体搬走、也不依赖 node_modules。

装进 `$DSH_HOME/.agent-presets/repo-tutor/`，重启 DSH 后在模式选择器里选「导师模式」。
**0.2 起这个目录没有任何代码去读了**，安装器会在结尾提醒你改用 bundle。

### 导师模式（第五个模式）

DSH 自带四个模式（标准 / PTC / 极简 / 创造），都从"编码 Agent"出发。导师模式是第五个，
也是最窄的一个：**只教，不替你改**。选它，整段会话就是教学会话。

安装器会把插件本体复制进 preset 目录（`plugin/src`、`plugin/policies`），行写成
`./plugin/src/index.js`。**故意不用包名**：DSH 解析 preset 行里的包名时，基准是
已安装的 harness，不是用户的 profile，装进 profile 的包它看不见；`./` 开头的名字
按 preset 自己的目录解析（Include 会改写 baseUrl），从 checkout 跑和从 npm 包跑都一样。

## 升级、换版本、卸载

```sh
npx repo-tutor-dsh@next                 # 重跑就是升级：只覆盖「还是我们写的那份」的文件
npx repo-tutor-dsh@next --status        # 装了什么版本、装在哪、哪些文件被本地改过
npx repo-tutor-dsh@next --uninstall     # 卸载；本地改过的文件先备份
npx repo-tutor-dsh@next --version
npx repo-tutor-dsh@next --help
```

- **本地改过就备份**：安装器写一份 `installed.json`（版本、Core 来源、每个受管文件的
  sha256）。再次安装时只覆盖内容没变的文件；内容变了就是本地改过的，覆盖前整体备份到
  `backup-<时间戳>/` 并在输出里点名。
- **升级会清掉旧文件**：上一版有、这一版没有的文件会被删掉（包括改了名字的旧二进制），
  不残留失效路径。
- **卸载只删原样文件**：改过的移到 `kept-<时间戳>/` 保留。`--force` 是不保留的强卸。
- **Bundle 模式的升级**跟着 npm 走：`dsh plugin --profile web add repo-tutor-dsh@next`
  重跑一次；主包和平台包必须同版本，版本漂了插件会在启动时直接报错而不是半路出错。
- **不重启就换不了行为**：roster 每次调用都重读目录，所以显示名、说明立刻生效；但
  preset 一旦被某个会话挂载过，这份组合就钉在那个进程里直到进程退出。改完 preset 或
  插件代码要重启一次 DSH 进程。

## 已知限制

按「会不会咬到人」排序：

1. **macOS 不支持。** `darwin-arm64` 在 `platforms.config.json` 里是 `publish: false`：
   它可以构建、可以跑测试，但不出包、不进 `optionalDependencies`。没人在 macOS 上真跑过
   DSH + 导师模式，所以这一版不宣称支持。
2. **Linux x64 的二进制要求 glibc ≥ 2.38。** 它是这轮在 WSL2 Ubuntu 24.04（glibc 2.39）
   上编译的，静态 libstdc++/libgcc 顺带把构建机的符号要求带了进来：实测需要
   `__isoc23_strtoul@2.38`、`arc4random@2.36`、`_dl_find_object@2.35`。
   也就是说 Ubuntu 22.04（glibc 2.35）、Debian 12（2.36）上用不了这个包。
   修法是让 CI 在 `ubuntu-22.04` 上重新出包（见下），不是改代码。
3. **DSH 0.1.7 与 0.2.0–0.2.2 没测。** `engines.dsh` 写成两段是因为只验过两端的机制：
   0.1.6 用目录式 preset，0.2.3 用 bundle 声明式，中间没有样本。
4. **Linux 上没跑过 DSH 端到端。** Core 层面（ctest、协议、client-smoke）是通的，
   但「插件 + DSH + 导师模式」这条链只在 Windows 上走过。
5. **没有 Conversation Node UI。** 输出走工具结果和 `/tutor` 命令，没有自定义渲染卡片。
   原因见文末。
6. **`blockBypassTools` 摘不掉无关的全局插件。** DSH 的 `tools.restrict()` 只认具体工具名，
   导师模式摘得掉 `read`/`grep`/`shell`/`web`/子代理这些通用工具，摘不干净第三方插件
   自己注册的工具。
7. **一个仓库根一份 Core。** 同一仓库的两个对话共享学习状态，不同仓库各用各的。
   跑多个 DSH 进程时每个进程自己一份，互相看不见。
8. **证据读取 6000 字节封顶。** 大文件会被截断，这正是证据预算想要的效果，但读
   「一整个 3000 行文件」这种请求会被拦。
9. **教学质量不由 Core 保证。** Core 管状态机、Topic Lock、证据冻结这些硬约束；
   「讲得对不对」只能靠模型和 prompt。「每个单元一次检查」是 prompt 的默认行为，
   不是协议强制的。

## 排错

| 现象 | 什么意思 | 怎么办 |
|---|---|---|
| `repo-tutor-core not found for win32-x64.` 后面跟 `@repo-tutor/core-win32-x64@0.1.0-rc.1 is not installed` | 平台包没装下来 | 去掉 `--omit=optional` 重装；或 `npm i @repo-tutor/core-win32-x64@0.1.0-rc.1`；或设 `REPO_TUTOR_CORE`；或在 preset 行里写 `corePath` |
| `does not match repo-tutor-dsh@0.1.0-rc.1; the platform package is version-locked` | 主包和平台包版本漂了 | 两边都装同一版本；别手工钉住一个旧平台包 |
| `protocol mismatch — this plugin speaks 0.1, but the Core at … negotiated …` | 插件和 Core 不是同一代 | 重装，让它们从同一个包里来；混用不支持 |
| `corePath points at a missing file` | preset 里的相对路径失效（目录被搬走 / 手改过） | 重跑 `npx repo-tutor-dsh@next`；或改成绝对路径 |
| `REPO_TUTOR_CORE points at a missing file` | 环境变量指错了 | 改对，或者删掉它（空字符串会被当成没设） |
| DSH 日志里这行显示 `never started` | `apply` 抛异常，被 loader 吞成了 error 日志 | 在同一行上方找 `error`，多数是 Core 解析失败或协议不匹配 |
| `error: … already exists … pass --force` | 那个 preset 目录不是这个安装器装的 | 加 `--force`（先备份再覆盖）；或者先手动看清里面是什么 |
| `npm error code E404` 出现在安装时 | 预发布版本只挂 `next`，`latest` 上没有 | 用 `repo-tutor-dsh@next` 或精确版本 |
| 选完模式发现没有 `tutor_*` 工具 | 选的是标准模式，不是导师模式 | 选「导师模式」；标准模式下 Tutor 工具虽然在全局注册，但被 restrict 挡住了 |
| 改完 preset 没反应 | 组合被 standing mount 钉住了 | 重启 DSH 进程 |
| Windows 上 `STATUS_DLL_NOT_FOUND` | Core 不是静态链接的 | 用平台包里的二进制，别用自己编的 Debug 版 |

## 发布（维护者）

```sh
npm run check          # = node scripts/release-check.mjs
```

`release-check.mjs` 查八件事，全绿才谈发布：版本一致性（主包 == 每个平台包 ==
`optionalDependencies` 的精确值）、依赖表 == 可发布平台集合、`publishConfig` 的
access/tag、**每个包各自一个隔离目录**打包（并发跑不会互相覆盖）、tarball 清单与敏感
文件、**署名只有一个写法**（`Copyright (c) 2026 Wang-yifan666`，平台包的 LICENSE 必须与
主包逐字节相同）、SHA-256、`npm publish --dry-run`。产物落在 `dist/rc/<时间戳>/`，附带
`SHA256SUMS`。

**顺序不能反**：平台包先发，主包最后发。反过来不会「装不上」，会更糟 —— 实测只装主包
时 npm 打一行 `added 1 package`、退出码 0、一个 warning 都没有（`optionalDependency`
在 registry 上取不到就被静默跳过），用户要到跑插件的那一刻才看见
`repo-tutor-core not found`。主包的 `optionalDependencies` 是精确版本，没有兜底。

发的是 `release-check` 打出来的 tgz，不是目录：这样 registry 上的字节就是算过
SHA-256 的那一份，事后能用 `npm view <pkg>@<ver> dist.integrity` 对回来。

```sh
# 1) 平台包（Windows / Linux 各一次）
npm publish dist/rc/<时间戳>/repo-tutor-core-win32-x64-0.1.0-rc.1.tgz  --tag next --access public
npm publish dist/rc/<时间戳>/repo-tutor-core-linux-x64-0.1.0-rc.1.tgz  --tag next --access public

# 2) 主包
npm publish dist/rc/<时间戳>/repo-tutor-dsh-0.1.0-rc.1.tgz  --tag next
```

`0.1.0-rc.1` 带 `-rc.` 后缀，`publishConfig.tag` 也写死成 `next`：直接 `npm publish`
不会污染 `latest`。**正式版发布前必须把 `publishConfig.tag` 改回 `latest`**，
`release-check` 会拿版本号去比对，改漏了会当场失败。

**回滚**（发布后才发现问题）：

```sh
# 撤标签：把 next 移回上一个可用版本
npm dist-tag add repo-tutor-dsh@0.1.0-rc.0 next
# 或者撤掉整个版本（72 小时内允许，超过就不行了）
npm unpublish repo-tutor-dsh@0.1.0-rc.1
npm unpublish @repo-tutor/core-win32-x64@0.1.0-rc.1
```

已经有人装了就发一个新补丁（`0.1.0-rc.2`），别指望 unpublish —— 它不影响已装上的人。

**CI**：`.github/workflows/core-platforms.yml` 有三个原生 runner（windows-2022 /
ubuntu-22.04 / macos-14）。到这一版为止它**一次都没跑过**（这几轮的约束都是不推送），
所以 CI 结果不能作为验收依据。Linux 的本地等价流程是
`BUILD=build/rc-linux bash hosts/dsh/test/linux-native.sh`（WSL）。

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
没有 fs / shell / web / 子代理行的组合。

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
src/index.js                       插件本体（工具 / prompt 小节 / /tutor 命令）
src/core-client.mjs                spawn core + 逐行 JSON-RPC
src/platform-core.mjs              平台包解析（插件和安装器共用）
policies/tutor-prompt.md           教学 prompt 正文
preset/                            0.1.x 的目录式组合模板（0.2 起没人读，只为安装器保留）
scripts/install-preset.mjs         导师模式安装器（bin: repo-tutor-dsh）
scripts/verify-package.mjs         发布前自检（npm pack + 解包 + 接线断言）
scripts/release-check.mjs          发布自检（版本 / 依赖表 / 隔离打包 / SHA-256 / dry-run）
scripts/make-platform-packages.mjs 生成平台包
cordis.patch.yml                   bundle 层：插 host 行 + 声明 preset-repo-tutor
platforms.config.json              平台与 scope 配置（依赖表从这里生成）
LICENSE / THIRD-PARTY-NOTICES.md   许可证，以及静态链接进来的 C++ 运行时归属
```

包内没有第三方 npm 依赖（`dependencies` 是空的），只有 `optionalDependencies` 指向
我们自己的平台包。C++ 那边零第三方库，静态链接的 libstdc++/libgcc 归属见
`THIRD-PARTY-NOTICES.md`。

## 验证

包内自检（不依赖 DSH 环境，会真的 `npm pack` 再解包检查）：

```sh
npm run verify
```

仓库里还有更重的验收（都在临时目录里跑，不碰真实 `$DSH_HOME`）：

```sh
node hosts/dsh/test/preset-dsh02.mjs          # DSH 0.2+：bundle 声明的 preset 真的能起、能跑完一轮
node hosts/dsh/test/installer-lifecycle.mjs   # 重复安装 / 用户改动 / 升级 / 卸载
node hosts/dsh/test/platform-core.mjs         # 平台包解析、协议握手、缺包报错
node hosts/dsh/test/preset-scope.mjs          # 作用域：全局视图没有 Tutor 工具，agent 上才有（0.1.x）
node hosts/dsh/test/preset-negative.mjs       # 破坏 preset 入口 → 工具确实不可调用（0.1.x）
node hosts/dsh/test/isolated-platform.mjs     # tarball 装进隔离 DSH_HOME，Bundle 与 Preset 各跑一轮（0.1.x）
BUILD=build/rc-linux bash hosts/dsh/test/linux-native.sh   # WSL / Linux 上的原生产出验证
```

需要 DSH 的几项都读 `DSH_HARNESS`；`preset-dsh02.mjs` 和 `isolated-platform.mjs` 还要凭据和模型。
`preset-scope` / `preset-negative` / `isolated-platform` 走的是 0.1.x 的目录式 preset，在 0.2+
的 checkout 上会自动 `SKIPPED` 并以 0 退出，别把那个绿当成通过。

## 还没做：Conversation Node

完整的 DSH Web UI（`ConversationNodeDefinition`）没做，有两个实际障碍：

1. **session event 的 ignorable 机制**：out-of-tree 插件的事件类型不在
   `KNOWN_SESSION_EVENT_TYPES` 里，而 `Session.append()` 不会设置 `ignorable`
   标记，外部插件用 append 发的自定义事件会被持久化读路径拒绝。
2. **client bundle 构建**：`dsh.client` 声明需要构建出 `./client` bundle，
   依赖 DSH 内部的 tsdown preset；out-of-tree 插件没有现成的构建路径。

在那之前，工具输出和 `/tutor` 命令就是 UI surface。

## 生命周期与已知风险

- Core 按**仓库根**一份，插件卸载时全部关掉。
- 仓库根来自这条调用所属会话的工作目录（`agent.session.header.cwd`），不是宿主进程 cwd。
- Core 在 stdin EOF 时自行退出，所以强杀宿主不会留下孤儿进程（实测有效，
  但没有兜底以外的保证）。

MIT — Copyright (c) 2026 Wang-yifan666 (https://github.com/Wang-yifan666).
