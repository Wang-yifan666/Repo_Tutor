# Repo Tutor

[English](README.md) | 中文

一个仓库导师。带你把陌生的代码库读成自己的东西——读完能自己理解、调试、改。

它做的事就是一轮一轮地带你读：

```
Recon → Repository Map → Learning Map → Learning Unit
      → Guided Reading → 可选的检查 → 评估 → 下一个单元
```

一个单元只服务一个认知目标。协议上题目不是必经状态（Core 不强制），但教学上默认每个单元做一次检查——讲完不代表讲进去了。

## 为什么值得做

让 AI 讲懂一个仓库，最常见的产出是一篇摘要。摘要读完就忘，下次还得再问一遍。真正的差别在于有没有亲手走过那条路径：哪一行是关键、为什么这么写、改坏了会怎样。这件事只能一行一行读出来。

所以我把它做成教学过程，而不是一次性的回答。

## 第五个模式：导师模式

DSH 自带四个模式（标准 / PTC / 极简 / 创造），都从编码 Agent 出发。导师模式是第五个，也是最窄的那个：**只会教，不会替你改**。

选了它，整段会话就是教学会话——不用模型自己判断"这句算不算学习请求"，边界不存在了。

```sh
node scripts/install-preset.mjs
```

装完新开会话，在模式选择器里选「导师模式」。改完 preset 或插件代码要重启 DSH 进程——组合一旦被挂载就钉在进程里了。它砍掉了 `read` / `grep` / `shell` / `web` 这些旁路，看代码只剩 `tutor_evidence_read` 一条路，证据预算和冻结快照才拦得住。

## 约束在 Core 里，不在提示词里

模型会忘、会偷懒、会把整段代码抄给你。所以几条硬规则写死在 C++ Core 的状态机里：

- **Topic Lock**——当前单元没完成，不许切走
- **Depth**——只能往更深处下钻，逐层返回，不能横着飘
- **Evidence Budget**——每次读代码都要写理由，路径不许跑出仓库
- **Question 契约**——提问那一刻冻结证据，判题只能用那份快照（Evaluation Before Exploration）

DSH 插件只做转发：spawn Core，把工具调用变成 JSON-RPC。判分、状态机、证据预算，一行 TS 都没有。

## 架构

```
core/ (C++)  →  Tutor Protocol (JSON-RPC 2.0 over stdio)  →  hosts/dsh/  →  DSH
```

- `core/` 是纯 C++，不知道 DSH 存在
- `apps/repo-tutor-core/` 是唯一的进程边界，JSON 只在这里出现
- `hosts/dsh/` 只做 spawn、转发、生命周期

以后要接别的宿主（VS Code 之类），换掉最后一段就行。

## 跑起来

```sh
# 构建 Core
cmake --preset dev-mingw && cmake --build --preset dev-mingw

# 试玩：起一个带插件的 DSH Web，cwd 就是要读的仓库
$env:DSH_HARNESS = "D:\DSH\deepseek-harness"
node scripts/try.mjs                       # 读本仓库
node scripts/try.mjs D:\path\to\repo       # 读别的仓库

# 或者装成导师模式，长期用
node scripts/install-preset.mjs
```

## 当 npm 包装

`hosts/dsh/` 本身就是一个符合 DSH Bundle 规范的 npm 包（`dsh.bundle.patch` 指到
`cordis.patch.yml`），C++ Core 则按平台单独发行，版本锁死在同一号：

| npm 包 | 是什么 |
|---|---|
| `repo-tutor-dsh` | 插件本体、导师模式安装器、bundle patch |
| `@repo-tutor/core-win32-x64` | Windows x64 的 Core 二进制（端到端验证过） |
| `@repo-tutor/core-linux-x64` | Linux x64 的 Core 二进制（WSL2 Ubuntu 上构建并过了协议测试，要求 glibc ≥ 2.38） |

macOS 不发：没人在真机上跑过，就不宣称支持 —— `platforms.config.json` 里
`darwin-arm64` 是 `publish: false`。

`0.1.0-rc.1` 是预发布版，只挂在 `next` 标签上，装的时候要写出来：

```sh
dsh plugin --profile <name> add repo-tutor-dsh@next       # Bundle 模式，平台 Core 一起装下来
npx repo-tutor-dsh@next                                    # 装导师模式
npx repo-tutor-dsh@next --core /path/to/repo-tutor-core     # 或者自己管 Core
npx repo-tutor-dsh@next --status | --uninstall | --version | --help
```

它会把插件复制进 preset 目录，不依赖你本地有源码仓库；重复安装就地升级，
本地改过的文件先备份，上一版有、这一版没有的文件会被清掉。

两个闸，都在 `hosts/dsh` 下跑：

```sh
npm run check     # 发布自检：版本一致性、依赖锁、隔离打包、tarball 清单、SHA-256、publish --dry-run
npm run verify    # 安装自检：白名单、解包、临时 DSH_HOME 里的安装器、真实 Core 往返
```

已知限制（macOS 不支持、Linux 的 glibc 下限、DSH 0.2.x 没测）和排错清单在
`hosts/dsh/README.md`。


## 测试

```sh
node scripts/smoke.mjs                     # 构建 + 9 个 CTest + 协议走查 + 插件接线
node scripts/smoke.mjs --model             # 再加上模型驱动验证（要 DSH_HARNESS）
```

`tutor-loop-smoke` 会让模型自己把完整闭环跑一遍（scan → map → unit → evidence → question → answer → evaluation → complete），判定读的是 Core 的协议轨迹，不看模型自述。

## 当前状态

**已实现**

- Core 的四个不变量 + Question 契约，13 个协议方法
- 11 个 `tutor_*` 工具 + `/tutor` 命令
- 完整教学闭环跑通：模型自己驱完一整轮，中途还会用 depth 下钻
- 第五个模式「导师模式」
- `0.1.0-rc.1` 的 npm 包：主包，加 Windows x64 / Linux x64 两个平台包

**还没做**

- 会话内的 Conversation Node UI（两个障碍记在 `hosts/dsh/README.md`）
- 仓库分析只到文件级，没有符号表、调用图
- macOS arm64：CI 矩阵里会构建，但标着 `publish: false` —— 真机上一轮都没跑过
- CI workflow 一次都没执行过（这些轮次都没推送），目前所有结果都是本地的
- 同一仓库的两个对话共享一份学习状态，别同时教两个单元

## 目录

```
core/                C++ 领域层（不变量、证据预算、Question 契约）
apps/repo-tutor-core/ 进程边界：JSON-RPC 服务端
hosts/dsh/          DSH adapter + 导师模式的 preset 模板
policies/           教学行为指引（注入给模型的那份在 hosts/dsh/policies/）
tests/              CTest：单元、协议黑盒、垂直切片
scripts/            构建、试玩、安装、验证脚本
```
