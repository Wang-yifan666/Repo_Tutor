# Repo Tutor

English | [中文](README_cn.md)

Make AI your tutor, helping you understand large code repositories or AI-generated content through Q&A.

> A plugin built for DSH; it may later be adapted for VS Code.

## Try it

```sh
$env:DSH_HARNESS = "D:\DSH\deepseek-harness"
node scripts/try.mjs                    # tutor this repo
node scripts/try.mjs D:\path\to\repo    # tutor another repo
```

That boots DSH Web with the plugin loaded — the repo you point at is both the workspace
and the tutor's repository root. Then just say "walk me through this repo".
