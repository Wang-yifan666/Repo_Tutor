# Repo Tutor 0.1.0-rc.1

第一个可以公开发布的预发布版。装在 DSH 里就是一个只教不改的第五种模式：
按 Learning Unit 逐个机制带你读懂一个陌生仓库，读代码走证据预算，出题用提问卡，
判题只认提问那一刻冻结的证据。

**这是预发布版**，只挂在 `next` 标签上，安装要写 `@next`。

## 支持什么

| 平台 | 状态 |
|---|---|
| Windows x64 | 支持。端到端跑过：真实模型 + 导师模式，完整教学一轮（status → scan → propose_map → open_unit → evidence_read → complete_unit） |
| Linux x64 | 发布，但只在协议层验证过（ctest 9/9、client-smoke、平台包自检）；没在 Linux 上装过 DSH。二进制要求 **glibc ≥ 2.38** |
| macOS arm64 | **不支持**，不发包 |

DSH：`0.1.6-alpha.1` 与 `0.2.3-alpha.2` 上都验证过整轮教学。这两个版本的 preset 机制不同 ——
0.1.x 是 `$DSH_HOME/.agent-presets/<id>/` 目录式，0.2 起改成 bundle 里的
`@deepseek-ai/dsh-agent-preset` 声明行，`engines.dsh` 因此写成两段：
`>=0.1.6-alpha.1 <0.2.0 || >=0.2.3-alpha.2 <0.3.0`，中间版本没有样本。

## 装

```sh
# DSH 0.2 及以后：一条命令，插件行 + 导师模式一起到位
dsh plugin --profile web add repo-tutor-dsh@next

# DSH 0.1.x：导师模式走目录式 preset，要跑安装器
npx repo-tutor-dsh@next
npx repo-tutor-dsh@next --status | --uninstall | --version | --help
```

0.2 之后 `$DSH_HOME/.agent-presets/` 不再被读取，安装器只对 0.1.x 有意义（它会在结尾提醒）。
Core 的解析顺序：行里的 `corePath` → `REPO_TUTOR_CORE` → 平台包 → 源码构建产物。

## 包里有什么

| 包 | 内容 |
|---|---|
| `repo-tutor-dsh@0.1.0-rc.1` | 11 个 `tutor_*` 工具、一节教学 prompt、`/tutor` 命令、导师模式安装器、bundle patch |
| `@repo-tutor/core-win32-x64@0.1.0-rc.1` | Windows 的 C++ Core（静态链接，只依赖 `KERNEL32.dll` / `msvcrt.dll`） |
| `@repo-tutor/core-linux-x64@0.1.0-rc.1` | Linux 的 C++ Core（静态 libstdc++/libgcc，动态 glibc） |

平台包和主包版本精确锁定。少一个，插件会报一条把四条出路都列出来的错误，
而不是静默降级。

## 发布产物与 SHA-256

`hosts/dsh/scripts/release-check.mjs` 打出来的就是这些，发布时按路径上传，
registry 上的字节就是这张表里算过的那一份。

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `repo-tutor-dsh-0.1.0-rc.1.tgz` | 47 276 | `8a34179e6322082cf8362677d1a02dd565653099e79a3adf1697a7a3b8c71ab6` |
| `repo-tutor-core-win32-x64-0.1.0-rc.1.tgz` | 675 037 | `d6449c66468d57fcc5597c1ae666dd61f59c2bf03aa56528ad32148c0859d1a3` |
| `repo-tutor-core-linux-x64-0.1.0-rc.1.tgz` | 608 839 | `8030b99acc8d1fde80c56d56e416915555af167d32261b1e6e1ec2b63caaf16b` |

包里的二进制：

| 二进制 | 字节 | SHA-256 |
|---|---|---|
| `repo-tutor-core.exe`（Windows x64） | 2 916 981 | `5e91acd730ba5f5eb37ded25594e56c7a3a49d15aa11034ffc583169755b4f9a` |
| `repo-tutor-core`（Linux x64） | 1 797 688 | `130fbb5e460ee5237871246428b8205fbd0241014cf0f376342ec21cdc608c7b` |

## 验证方式（本地 vs CI）

全部结果都是本地的。GitHub Actions 一次都没跑过（`main` 至今没推上去，
远端连 `.github/workflows/` 都没有），所以这一版没有任何 CI 原生证据。

| 项 | 结果 | 在哪 |
|---|---|---|
| C++ 测试 | 9/9 | Windows（clang 21.1.5 + MinGW）、WSL2 Ubuntu |
| 协议链 | 通过 | Windows / Linux 都跑了 client-smoke |
| 平台包自检 | 通过 | 依赖库、SHA-256、协议冒烟、执行位 |
| 安装器生命周期 | 通过 | 临时 `DSH_HOME`，31 项链路断言 |
| 作用域 | 通过 | 全局视图没有 Tutor 工具；标准 agent 没有 Tutor 工具；导师 agent 没有 `read` |
| 破坏测试 | 通过 | 弄坏 preset 入口 → 工具确实不可调用 |
| 发布自检 | 86 项 | 版本一致性、依赖表、署名、tarball 清单、内容扫描、SHA-256、`publish --dry-run` |
| 安装自检 | 54 项 | 解包、临时 `DSH_HOME` 里跑安装器、真实 Core 往返 |
| 端到端（0.1.6） | 通过 | 真实模型，Bundle 与 Preset 各一轮 |
| 端到端（0.2.3） | 通过 | bundle 声明的 preset 出现在 roster、`composedPreset=repo-tutor`、六步工具全跑、`read` 仍被禁 |

## 已知限制

1. macOS 不发。`darwin-arm64` 在 `platforms.config.json` 里是 `publish: false`，
   CI 矩阵照常构建它，但不出包、不上传。
2. Linux x64 的 glibc 下限是 2.38（`__isoc23_strtoul@2.38`、`arc4random@2.36`、
   `_dl_find_object@2.35`），因为这一版是在 glibc 2.39 的机器上编的。Ubuntu 22.04
   （2.35）用不了。修法是让 CI 在 `ubuntu-22.04` 上重新出包。
3. Linux 上没跑过 DSH 端到端，只验证到 Core 与协议。
4. 中间的 DSH 版本（0.1.7、0.2.0–0.2.2）没有样本：只验了两端的 preset 机制。
5. 没有 Conversation Node UI，输出是工具结果和 `/tutor` 命令。
6. 一个仓库根一份 Core：同一仓库的两个对话共享学习状态。
7. 「每个单元一次检查」是 prompt 的默认行为，不是协议强制。

## 升级与卸载

```sh
npx repo-tutor-dsh@next              # 就地升级，本地改过的文件先备份
npx repo-tutor-dsh@next --uninstall   # 卸载，改过的文件移到 kept-<时间戳>/
```

版本一换就该重启 DSH 进程：preset 组合一旦被会话挂载就被钉住，改代码要重启才生效。

## 许可证

MIT，Copyright (c) 2026 Wang-yifan666（https://github.com/Wang-yifan666）。
静态链接的 libstdc++ / libgcc / mingw-w64 运行时归属见 `THIRD-PARTY-NOTICES.md`：
GCC 运行时库例外允许以 MIT 分发编译产物，glibc 动态链接未修改，不吸收 GPL 源码。
