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

## Tutor mode

DSH ships four agent modes; this project adds a fifth that only teaches and never
edits your code. Selecting it makes the whole session a tutoring session, so the model
never has to decide whether a message is a "learning request".

```sh
node scripts/install-preset.mjs
```

Then start a new session and pick 仓库导师模式 in the mode selector.
