# stordai

**The flight recorder + undo button for AI agents.**

Run `claude --dangerously-skip-permissions` or `codex --dangerously-bypass-approvals-and-sandbox`
without holding your breath. stord journals every file your agents **read** and **write** —
attributed to the agent that did it — and makes every write reversible.

```
$ stord log --reads

stord journal — 4 operations

  7d5796e1d6  2026-06-11 19:25:40Z  claude-code#a81f02  read  .env
  a61eed45ae  2026-06-11 19:25:41Z  claude-code#a81f02  Edit src/app.js
              1 file +12 -3
  db4890e7a9  2026-06-11 19:26:02Z  codex#thread-7      $ rm -rf build/
              31 files -2,114
  1110c3ff57  2026-06-11 19:26:30Z  openclaw            read  secrets.txt

$ stord undo db4890e7a9
✓ undid db4890e7a9 ($ rm -rf build/)
```

One Node file. **Zero dependencies.** Your real git repo is never touched.

![stord demo: an agent reads .env and rm -rfs build/, stord log shows who did what, stord undo brings it back](https://raw.githubusercontent.com/ishwantsingh/stordai/main/demo.gif)

## Install

```bash
npm install -g stordai        # the `stord` command now works anywhere
cd your-project
stord enable
```

Or run from source:

```bash
git clone https://github.com/ishwantsingh/stordai && cd stordai && npm link
```

Requires Node ≥ 18 and git ≥ 2.30.

## What you get

| | |
|---|---|
| `stord log` | timeline of everything agents changed (`--reads` to include what they read) |
| `stord show <id>` | the exact diff of one operation |
| `stord undo <id>` | surgically reverse one operation — even if it was `rm -rf` |
| `stord restore --before <id>` | roll the whole tree back to any point |
| `stord agents` | per-agent rollup: ops, reads, lines, sessions, last seen |
| `stord ui` | local web timeline — filter by agent, toggle reads, click for diffs |
| `stord watch` | journal agents that have no hook system at all |

Every entry records **who acted**: agent name, session id, OS user. Name agents in a
fleet with `STORD_AGENT=deploy-bot claude …` and ask questions like *"show me everything
deploy-bot touched yesterday"* (`stord log --agent deploy-bot`).

## Works with

- **Claude Code** — fully automatic. `stord enable` installs Pre/PostToolUse hooks;
  every `Write`/`Edit`/`Bash` is snapshotted, every `Read`/`Grep`/`Glob` is journaled.
- **Codex** — wire its [lifecycle hooks](https://developers.openai.com/codex/hooks) at
  `stord hook pre --agent codex` / `stord hook post --agent codex`. The payload
  normalizer tolerates harness schema differences.
- **Hermes, OpenClaw, custom agents** — call `stord event read --file <p> --agent <name>`
  from any plugin hook or script, and/or run `stord watch --agent <name>` for write
  coverage with zero integration.

## How it works

`stord enable` creates a shadow git repo at `.stord/shadow.git` pointing at your worktree —
completely separate from your real git history. Hooks snapshot the tree around every
write-capable tool call, producing an append-only journal with full diffs. Reads are
journaled as lightweight events (who read what, when) — no snapshot, since there's
nothing to undo about a read.

`undo` reverse-applies one operation's diff. If later operations touched the same files
it refuses, and offers `--force` (per-file rollback) or `restore --before <id>`
(whole-tree rollback). Undo and restore are themselves journaled, so undo is undoable.

## Why not just git?

Git records what someone chose to commit. stord records what agents actually did:
mid-task states nobody would commit, files outside your commit discipline, and — the
part git can't do — **attribution the agent doesn't control**. Git's author field is
whatever the committer claims; stord binds operations to agent/session/user at capture
time. It keeps working while an agent is rebasing or force-pushing your real repo, and
it answers "which of my agents read `.env`?" — a question git has no concept of.

## Honest limitations

- Protects the project tree it's enabled in; writes outside the repo root aren't journaled.
- `.gitignore`-matched files aren't journaled (which also makes `node_modules` churn free).
- Read tracking is hook-level: reads inside shell commands (`cat` in a Bash call) aren't
  attributed, and `stord watch` can't see reads at all.
- The journal lives on the same machine as the agent. An agent with shell access can
  delete it. **Local stord is a seatbelt, not a security boundary.**

That last one is the roadmap: a cloud version with tamper-evident, off-host audit
trails, issued per-agent credentials instead of self-reported names, and fleet-wide
dashboards — evidence you can hand an auditor, not just yourself.
**[Join the waitlist →](https://stordai.com)**

## License

MIT
