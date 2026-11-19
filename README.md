# Repo Tutor

English | [中文](README_cn.md)

A repository tutor. It walks you through an unfamiliar codebase until you can read, debug and change it on your own.

The work happens one round at a time:

```
Recon → Repository Map → Learning Map → Learning Unit
      → Guided Reading → optional check → evaluation → next unit
```

One unit serves exactly one cognitive goal. Questions are an optional verification step, not a required stage.

## Why bother

Ask an AI to explain a repository and you usually get a summary. You read it, you forget it, you ask again next week. The difference is whether you have walked the path yourself: which line carries the point, why it is written that way, what breaks when you change it. That only comes from reading the code, line by line.

So this is a teaching process, not a one-shot answer.

## The fifth mode: Tutor

DSH ships four agent modes (standard / PTC / minimal / cordis), all built for a coding agent. Tutor is the fifth and the narrowest: **it only teaches, it never edits your code**.

Pick it and the whole session is a tutoring session — the model never has to decide whether a message is a "learning request".

```sh
node scripts/install-preset.mjs
```

Start a new session and choose 「导师模式」 in the mode selector. The mode drops `read` / `grep` / `shell` / `web`, leaving `tutor_evidence_read` as the only way to look at code — which is what makes the evidence budget and the frozen question snapshot mean anything.

## The constraints live in the Core, not in a prompt

Models forget, get lazy, and paste whole files at you. So the hard rules sit in the C++ state machine:

- **Topic Lock** — you cannot switch away from an unfinished unit
- **Depth** — dives only go deeper, and return one level at a time
- **Evidence Budget** — every read needs a rationale; paths cannot leave the repository
- **Question contract** — the evidence is frozen at the moment of asking, and grading may only use that snapshot (Evaluation Before Exploration)

The DSH plugin only forwards: spawn the Core, turn tool calls into JSON-RPC. Scoring, the state machine and the evidence budget contain zero TypeScript.

## Architecture

```
core/ (C++)  →  Tutor Protocol (JSON-RPC 2.0 over stdio)  →  hosts/dsh/  →  DSH
```

- `core/` is plain C++ and knows nothing about DSH
- `apps/repo-tutor-core/` is the only process boundary; JSON appears nowhere else
- `hosts/dsh/` spawns, forwards, and manages the Core's lifetime

Adapting another host (VS Code, say) means replacing only the last segment.

## Running it

```sh
# build the Core
cmake --preset dev-mingw && cmake --build --preset dev-mingw

# try it: boots DSH Web with the plugin, cwd is the repo to study
$env:DSH_HARNESS = "D:\DSH\deepseek-harness"
node scripts/try.mjs                       # tutor this repo
node scripts/try.mjs D:\path\to\repo       # tutor another repo

# or install it as the Tutor mode
node scripts/install-preset.mjs
```

## Tests

```sh
node scripts/smoke.mjs                     # build + 9 CTest cases + protocol walkthrough + plugin wiring
node scripts/smoke.mjs --model             # plus model-driven checks (needs DSH_HARNESS)
```

`tutor-loop-smoke` has the model drive the whole loop itself (scan → map → unit → evidence → question → answer → evaluation → complete). Verification reads the protocol trace the Core printed, not the model's own report.

## Status

**Working**

- Four Core invariants plus the question contract, 13 protocol methods
- 11 `tutor_*` tools and the `/tutor` command
- The full teaching loop, driven end to end by the model (it even uses depth dives on its own)
- The fifth mode, Tutor

**Not done**

- An in-session Conversation Node UI (the two blockers are recorded in `hosts/dsh/README.md`)
- Repository analysis stops at the file level — no symbols, no call graph
- Packaging: today it runs from `--patch` or an installed preset
- Two conversations in the same repo share one tutor state, so don't teach two units at once

## Layout

```
core/                  C++ domain layer (invariants, evidence budget, question contract)
apps/repo-tutor-core/  process boundary: the JSON-RPC server
hosts/dsh/             DSH adapter + the Tutor mode preset template
policies/              teaching policy in full (what the model reads)
tests/                 CTest: units, protocol black box, vertical slice
scripts/               build, try, install, verify
```
