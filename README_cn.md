# Repo Tutor

[English](README.md) | 中文

让 AI 变成你的老师，通过问答帮助你理解大型的代码仓库或是 AI 生成内容。

> 为 DSH 开发的插件，以后可能会适配 VScode

## 先试试

```sh
$env:DSH_HARNESS = "D:\DSH\deepseek-harness"
node scripts/try.mjs                    # 读本仓库
node scripts/try.mjs D:\path\to\repo    # 读别的仓库
```

它起一个带插件的 DSH Web，你指的那个仓库同时是 workspace 和 tutor 的仓库根。
进去说一句「带我读懂这个仓库」就行。
