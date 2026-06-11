#!/usr/bin/env node
/**
 * stord — audit + undo layer for AI agent file operations.
 *
 * Every file your agents touch: audited, reversible.
 *
 * How it works:
 *   - `stord enable` creates a shadow git repo (.stord/shadow.git) that points
 *     at your worktree but is completely separate from your real git history.
 *   - Claude Code hooks (installed by `enable`) snapshot the tree before and
 *     after every Write/Edit/Bash tool call, producing an append-only journal
 *     of operations with full diffs.
 *   - Read-tool calls are journaled as lightweight `read` events (who read
 *     what), captured from hooks — no snapshot, nothing to undo.
 *   - `stord log` / `show` / `undo` / `restore` read that journal.
 *   - `stord event` ingests events from any other agent (codex, hermes,
 *     openclaw, custom) via their own hook/plugin mechanisms.
 *   - `stord watch` polls for changes for agents without hooks (writes only).
 *   - `stord ui` serves a local timeline UI over the journal.
 *
 * Zero dependencies. Requires git >= 2.30 and node >= 18.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import process from "node:process";

const SELF = fileURLToPath(import.meta.url);
const STORD_DIR = ".stord";
const SHADOW_DIR = "shadow.git";
const JOURNAL_FILE = "journal.jsonl";

// ---------------------------------------------------------------------------
// terminal colors (no deps)
// ---------------------------------------------------------------------------

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1");
const dim = c("2");
const red = c("31");
const green = c("32");
const yellow = c("33");
const cyan = c("36");
const magenta = c("35");

// ---------------------------------------------------------------------------
// root / paths
// ---------------------------------------------------------------------------

function findRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, STORD_DIR, SHADOW_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function requireRoot() {
  const root = findRoot();
  if (!root) {
    console.error(red("stord is not enabled here. Run `stord enable` in your project root first."));
    process.exit(1);
  }
  return root;
}

const stordDir = (root) => join(root, STORD_DIR);
const shadowGitDir = (root) => join(root, STORD_DIR, SHADOW_DIR);
const journalPath = (root) => join(root, STORD_DIR, JOURNAL_FILE);

// ---------------------------------------------------------------------------
// shadow git plumbing
// ---------------------------------------------------------------------------

function shadow(root, args, opts = {}) {
  const full = [
    "--git-dir", shadowGitDir(root),
    "--work-tree", root,
    "-c", "user.name=stord",
    "-c", "user.email=stord@local",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ];
  return spawnSync("git", full, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

function shadowOk(root, args, opts = {}) {
  const r = shadow(root, args, opts);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/** Retry wrapper for index.lock contention (parallel hook invocations). */
function withLockRetry(fn, tries = 8) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      const msg = String(err && err.message);
      if (i < tries - 1 && (msg.includes("index.lock") || msg.includes("Unable to create"))) {
        const wait = 60 + i * 60;
        spawnSync("sleep", [String(wait / 1000)]);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Snapshot the worktree into the shadow repo.
 * Returns { pre, post, files, insertions, deletions } or null if nothing changed.
 */
function snapshot(root, message) {
  return withLockRetry(() => {
    shadowOk(root, ["add", "-A", "--", "."]);
    const hasHead = shadow(root, ["rev-parse", "--verify", "HEAD"]).status === 0;
    if (hasHead) {
      const diff = shadow(root, ["diff", "--cached", "--quiet", "HEAD"]);
      if (diff.status === 0) return null; // clean
    }
    const pre = hasHead ? shadowOk(root, ["rev-parse", "HEAD"]).trim() : null;
    shadowOk(root, ["commit", "-q", "--no-verify", "--allow-empty", "--allow-empty-message", "-m", message || ""]);
    const post = shadowOk(root, ["rev-parse", "HEAD"]).trim();
    let files = 0, insertions = 0, deletions = 0;
    if (pre) {
      const numstat = shadowOk(root, ["diff", "--numstat", pre, post]);
      for (const line of numstat.split("\n")) {
        if (!line.trim()) continue;
        files++;
        const [a, d] = line.split("\t");
        insertions += a === "-" ? 0 : Number(a);
        deletions += d === "-" ? 0 : Number(d);
      }
    }
    return { pre, post, files, insertions, deletions };
  });
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

function journalAppend(root, entry) {
  appendFileSync(journalPath(root), JSON.stringify(entry) + "\n");
}

function journalRead(root) {
  const p = journalPath(root);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function findEntry(root, id) {
  const entries = journalRead(root);
  if (id === "last" || id === "--last") {
    const ops = entries.filter((e) => e.kind !== "undo" && e.kind !== "restore" && e.kind !== "read");
    return ops[ops.length - 1] || null;
  }
  const matches = entries.filter((e) => e.id.startsWith(id));
  if (matches.length > 1) {
    console.error(red(`ambiguous id "${id}" (${matches.length} matches)`));
    process.exit(1);
  }
  return matches[0] || null;
}

/** OS principal the recording process ran as. Identity of last resort. */
function osUser() {
  try { return userInfo().username; } catch { return null; }
}

function makeEntry(root, kind, snap, extra = {}) {
  const entry = {
    id: snap.post.slice(0, 10),
    ts: new Date().toISOString(),
    kind,
    agent: null,
    user: osUser(),
    pre: snap.pre,
    post: snap.post,
    files: snap.files,
    insertions: snap.insertions,
    deletions: snap.deletions,
    ...extra,
  };
  journalAppend(root, entry);
  return entry;
}

/**
 * Read events have no snapshot, so no commit hash to derive an id from —
 * mint one the same width as the snapshot ids.
 */
function makeReadEntry(root, extra = {}) {
  const entry = {
    id: randomBytes(5).toString("hex"),
    ts: new Date().toISOString(),
    kind: "read",
    agent: null,
    user: osUser(),
    files: [],
    ...extra,
  };
  journalAppend(root, entry);
  return entry;
}

/**
 * Who, by kind: agent name when one acted, OS user for human recovery
 * actions, nothing for unattributed external drift.
 */
function attribution(e) {
  if (e.agent) return magenta(e.agent) + (e.session ? dim(`#${e.session.slice(0, 8)}`) : "");
  if (e.kind === "undo" || e.kind === "restore") return yellow(e.user || "user");
  return e.user ? dim(e.user) : dim("—");
}

// ---------------------------------------------------------------------------
// hooks (called by agent harnesses: Claude Code natively, Codex/Hermes/
// OpenClaw via their own hook/plugin config pointing at `stord hook`)
// ---------------------------------------------------------------------------

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Tolerate field-name differences between harness hook payloads. */
function normalizePayload(payload) {
  return {
    cwd: payload.cwd || payload.workdir || payload.working_directory || null,
    session: payload.session_id || payload.sessionId || payload.session || payload.thread_id || null,
    tool: payload.tool_name || payload.toolName || payload.tool || null,
    input: payload.tool_input || payload.toolInput || payload.input || payload.arguments || {},
  };
}

/** Tools that access file contents without changing them. */
function isReadTool(toolName) {
  return /^(read|grep|glob|search|view|open_file|read_file|list_dir)/i.test(String(toolName));
}

/** Pull every path-ish string out of a tool input, across harness schemas. */
function extractFiles(input = {}) {
  const out = [];
  for (const key of ["file_path", "notebook_path", "path", "file", "target_file", "filename"]) {
    if (typeof input[key] === "string" && input[key]) out.push(input[key]);
  }
  for (const key of ["files", "paths"]) {
    if (Array.isArray(input[key])) out.push(...input[key].filter((f) => typeof f === "string"));
  }
  return [...new Set(out)];
}

function toolSummary(toolName, input = {}) {
  if (/bash|shell|exec/i.test(String(toolName))) {
    const cmd = String(input.command || "").replace(/\s+/g, " ").trim();
    return cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd;
  }
  const files = extractFiles(input);
  if (files.length) return files.join(", ");
  if (typeof input.pattern === "string") return input.pattern;
  return "";
}

function cmdHook(phase, args = []) {
  // Hooks must never break the agent: fail open, always exit 0.
  try {
    const p = normalizePayload(readStdinJson());
    const root = findRoot(p.cwd || process.cwd());
    if (!root) return;
    const agent = process.env.STORD_AGENT || argValue(args, "--agent") || "claude-code";

    if (phase === "pre") {
      // Capture any drift since the last snapshot (human edits, background
      // processes) so it isn't mis-attributed to the upcoming tool call.
      const snap = snapshot(root, "external change");
      if (snap && snap.pre) {
        makeEntry(root, "external", snap, {
          session: p.session,
          note: "changes outside agent tool calls",
        });
      }
      return;
    }

    // post: reads are journaled as lightweight events, writes as snapshots
    const toolName = p.tool || "unknown";
    if (isReadTool(toolName)) {
      makeReadEntry(root, {
        agent,
        session: p.session,
        tool: toolName,
        files: extractFiles(p.input),
        summary: toolSummary(toolName, p.input),
      });
      return;
    }

    const snap = snapshot(root, `${toolName}: ${toolSummary(toolName, p.input)}`);
    if (snap && snap.pre) {
      makeEntry(root, "tool", snap, {
        session: p.session,
        agent,
        tool: toolName,
        summary: toolSummary(toolName, p.input),
      });
    }
  } catch (err) {
    try { console.error(`stord hook error: ${err && err.message}`); } catch { /* ignore */ }
  } finally {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// event (generic ingestion for agents with their own hook/plugin systems)
// ---------------------------------------------------------------------------

function cmdEvent(args) {
  const root = requireRoot();
  const kind = args.find((a) => !a.startsWith("-"));
  if (kind !== "read") {
    console.error(red("usage: stord event read --file <path> [--file <path>…] [--agent <name>] [--session <id>] [--tool <name>] [--summary <text>]"));
    console.error(dim("write events come from hooks (`stord hook`) or `stord watch` — they need a snapshot to be undoable."));
    process.exit(1);
  }
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) files.push(args[i + 1]);
  }
  const entry = makeReadEntry(root, {
    agent: argValue(args, "--agent") || process.env.STORD_AGENT || null,
    session: argValue(args, "--session") || null,
    tool: argValue(args, "--tool") || null,
    files,
    summary: argValue(args, "--summary") || files.join(", "),
  });
  console.log(`${cyan(entry.id)}  read recorded${entry.agent ? ` for ${magenta(entry.agent)}` : ""}${files.length ? `: ${files.join(", ")}` : ""}`);
}

// ---------------------------------------------------------------------------
// enable / disable / status
// ---------------------------------------------------------------------------

const WRITE_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash";
// reads only need the post hook (nothing to snapshot beforehand)
const POST_MATCHER = `${WRITE_MATCHER}|Read|Grep|Glob`;

function hookCommand(phase) {
  const node = process.execPath;
  return `"${node}" "${SELF}" hook ${phase}`;
}

function isStordHook(h) {
  return h && h.type === "command" && typeof h.command === "string" && h.command.includes("stord.mjs");
}

function installHooks(root) {
  const settingsPath = join(root, ".claude", "settings.local.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { settings = {}; }
  }
  settings.hooks = settings.hooks || {};
  for (const [event, phase, matcher] of [
    ["PreToolUse", "pre", WRITE_MATCHER],
    ["PostToolUse", "post", POST_MATCHER],
  ]) {
    let groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // drop any stale stord hooks, then add fresh
    groups = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isStordHook(h)) }))
      .filter((g) => (g.hooks || []).length > 0);
    groups.push({
      matcher,
      hooks: [{ type: "command", command: hookCommand(phase), timeout: 30 }],
    });
    settings.hooks[event] = groups;
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return settingsPath;
}

function removeHooks(root) {
  const settingsPath = join(root, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) return;
  let settings;
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { return; }
  if (!settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isStordHook(h)) }))
      .filter((g) => (g.hooks || []).length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function ensureGitignore(root) {
  const gi = join(root, ".gitignore");
  const line = ".stord/";
  const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!current.split("\n").some((l) => l.trim() === line || l.trim() === ".stord")) {
    writeFileSync(gi, current + (current.endsWith("\n") || current === "" ? "" : "\n") + line + "\n");
  }
}

function cmdEnable() {
  const root = process.cwd();
  const gitDir = shadowGitDir(root);

  if (!existsSync(gitDir)) {
    mkdirSync(stordDir(root), { recursive: true });
    // --git-dir before init puts the repo metadata at gitDir itself (no nested .git)
    const init = spawnSync("git", ["--git-dir", gitDir, "init", "-q", "--initial-branch=main"], {
      cwd: root,
      encoding: "utf8",
    });
    if (init.status !== 0) {
      console.error(red(`failed to init shadow repo: ${init.stderr}`));
      process.exit(1);
    }
    shadowOk(root, ["config", "core.bare", "false"]);
    shadowOk(root, ["config", "core.worktree", root]);
    shadowOk(root, ["config", "gc.auto", "0"]);
    // never journal our own bookkeeping
    writeFileSync(join(gitDir, "info", "exclude"), ".stord/\n.git/\n");
  }

  ensureGitignore(root);

  const baseline = snapshot(root, "baseline");
  if (baseline && !baseline.pre) {
    const tracked = shadowOk(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean).length;
    journalAppend(root, {
      id: baseline.post.slice(0, 10),
      ts: new Date().toISOString(),
      kind: "baseline",
      agent: null,
      user: osUser(),
      pre: null,
      post: baseline.post,
      files: tracked,
      insertions: 0,
      deletions: 0,
    });
  } else if (baseline && baseline.pre) {
    // re-enable with drift since the last snapshot: journal it honestly
    makeEntry(root, "external", baseline, { note: "changes captured on re-enable" });
  }

  const settingsPath = installHooks(root);

  console.log(bold(green("✓ stord enabled")) + ` in ${root}`);
  console.log(`  shadow journal  ${dim(join(STORD_DIR, SHADOW_DIR))}`);
  console.log(`  claude hooks    ${dim(settingsPath)}`);
  console.log();
  console.log(bold("Try it:"));
  console.log(`  ${cyan("claude --dangerously-skip-permissions")}   ${dim("# let the agent loose")}`);
  console.log(`  ${cyan("stord log")}                               ${dim("# everything it touched")}`);
  console.log(`  ${cyan("stord show <id>")}                         ${dim("# exact diff of one op")}`);
  console.log(`  ${cyan("stord undo <id>")}                         ${dim("# reverse one op")}`);
  console.log(`  ${cyan("stord watch")}                             ${dim("# audit agents without hooks (codex)")}`);
  console.log();
  console.log(dim("Note: restart any running claude session so it picks up the new hooks."));
}

function cmdDisable() {
  const root = requireRoot();
  removeHooks(root);
  console.log(green("✓ claude hooks removed.") + dim(` Journal kept at ${join(root, STORD_DIR)} — delete it to wipe history.`));
}

function cmdStatus() {
  const root = findRoot();
  if (!root) {
    console.log(yellow("stord: not enabled in this directory (run `stord enable`)."));
    return;
  }
  const entries = journalRead(root);
  const ops = entries.filter((e) => e.kind === "tool" || e.kind === "watch" || e.kind === "external");
  const reads = entries.filter((e) => e.kind === "read");
  const undos = entries.filter((e) => e.kind === "undo" || e.kind === "restore");
  const settingsPath = join(root, ".claude", "settings.local.json");
  let hooksOn = false;
  if (existsSync(settingsPath)) {
    try {
      hooksOn = JSON.stringify(JSON.parse(readFileSync(settingsPath, "utf8"))).includes("stord.mjs");
    } catch { /* ignore */ }
  }
  console.log(bold("stord status"));
  console.log(`  root           ${root}`);
  console.log(`  claude hooks   ${hooksOn ? green("installed") : red("not installed")}`);
  console.log(`  operations     ${ops.length} recorded, ${reads.length} reads, ${undos.length} undo/restore`);
  const names = [...new Set(entries.map((e) => e.agent).filter(Boolean))];
  if (names.length) console.log(`  agents         ${names.map((n) => magenta(n)).join(", ")}`);
  const last = entries[entries.length - 1];
  if (last) console.log(`  last activity  ${last.ts}  ${describe(last)}`);

  const drift = snapshotDryRun(root);
  console.log(`  worktree       ${drift ? yellow("has un-journaled changes") : green("clean vs journal")}`);
}

function snapshotDryRun(root) {
  const r = shadow(root, ["status", "--porcelain"]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

// ---------------------------------------------------------------------------
// log / show
// ---------------------------------------------------------------------------

function describe(e) {
  switch (e.kind) {
    case "tool": {
      const tool = e.tool === "Bash" ? magenta("$ " + (e.summary || "")) : `${e.tool} ${e.summary || ""}`;
      return tool;
    }
    case "read": {
      const what = (e.files || []).slice(0, 3).join(", ") || e.summary || "";
      const more = (e.files || []).length > 3 ? dim(` (+${e.files.length - 3} more)`) : "";
      return dim("read  ") + what + more;
    }
    case "external": return yellow("external change (outside agent tool calls)");
    case "watch": return cyan("watched change") + (e.summary ? dim(` ${e.summary}`) : "");
    case "undo": return red(`undo of ${e.target}`);
    case "restore": return red(`restore to before ${e.target}`);
    case "baseline": return dim("baseline snapshot");
    default: return e.kind;
  }
}

function statStr(e) {
  if (e.kind === "baseline") return dim(`${e.files} files captured`);
  if (e.kind === "read") return "";
  const parts = [];
  if (e.files) parts.push(`${e.files} file${e.files === 1 ? "" : "s"}`);
  if (e.insertions) parts.push(green(`+${e.insertions}`));
  if (e.deletions) parts.push(red(`-${e.deletions}`));
  return parts.join(" ");
}

function cmdLog(args) {
  const root = requireRoot();
  const json = args.includes("--json");
  const all = args.includes("--all");
  const nIdx = args.indexOf("-n");
  const limit = nIdx >= 0 ? Number(args[nIdx + 1]) : 25;

  const withReads = args.includes("--reads") || all;

  let entries = journalRead(root);
  if (!all) entries = entries.filter((e) => e.kind !== "baseline");
  const readCount = entries.filter((e) => e.kind === "read").length;
  if (!withReads) entries = entries.filter((e) => e.kind !== "read");
  const sessionFilter = argValue(args, "--session");
  if (sessionFilter) entries = entries.filter((e) => (e.session || "").startsWith(sessionFilter));
  const agentFilter = argValue(args, "--agent");
  if (agentFilter) entries = entries.filter((e) => e.agent === agentFilter);
  const shown = entries.slice(-limit);

  if (json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  if (shown.length === 0) {
    console.log(dim("no operations recorded yet."));
    return;
  }
  console.log(bold(`stord journal — ${entries.length} operation${entries.length === 1 ? "" : "s"}`) +
    (!withReads && readCount ? dim(` (+${readCount} reads, use --reads)`) : "") +
    (shown.length < entries.length ? dim(` (showing last ${shown.length}, use --all / -n)`) : ""));
  console.log();
  for (const e of shown) {
    const t = e.ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
    console.log(`  ${cyan(e.id)}  ${dim(t)}  ${attribution(e)}  ${describe(e)}`);
    const stat = statStr(e);
    if (stat) console.log(`  ${" ".repeat(10)}  ${stat}`);
  }
  console.log();
  console.log(dim(`stord show <id> for the diff · stord undo <id> to reverse · stord agents for who did what`));
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function cmdShow(args) {
  const root = requireRoot();
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) { console.error(red("usage: stord show <id>")); process.exit(1); }
  const e = findEntry(root, id);
  if (!e) { console.error(red(`no journal entry matching "${id}"`)); process.exit(1); }
  if (e.kind === "read") {
    console.log(`${cyan(e.id)}  ${dim(e.ts)}  ${attribution(e)}  ${describe(e)}`);
    for (const f of e.files || []) console.log(`  ${dim("·")} ${f}`);
    console.log(dim("read event — content was accessed, nothing changed, nothing to diff."));
    return;
  }
  if (!e.pre) { console.log(dim("baseline entry — no diff (it captured the initial state).")); return; }
  console.log(`${cyan(e.id)}  ${dim(e.ts)}  ${attribution(e)}  ${describe(e)}`);
  console.log();
  const r = shadow(root, ["diff", tty ? "--color=always" : "--color=never", "--stat", "-p", e.pre, e.post], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

/** Stable grouping label for an entry's identity. */
function identityKey(e) {
  if (e.agent) return e.agent;
  if (e.kind === "undo" || e.kind === "restore") return e.user ? `user:${e.user}` : "user:unknown";
  return "(unattributed)";
}

function cmdAgents(args) {
  const root = requireRoot();
  const json = args.includes("--json");
  const entries = journalRead(root).filter((e) => e.kind !== "baseline");

  const byAgent = new Map();
  for (const e of entries) {
    const key = identityKey(e);
    let a = byAgent.get(key);
    if (!a) {
      a = { agent: key, ops: 0, reads: 0, undos: 0, files: 0, insertions: 0, deletions: 0, sessions: new Set(), first: e.ts, last: e.ts };
      byAgent.set(key, a);
    }
    if (e.kind === "read") a.reads++;
    else if (e.kind === "undo" || e.kind === "restore") a.undos++;
    else a.ops++;
    if (e.kind !== "read") {
      a.files += e.files || 0;
      a.insertions += e.insertions || 0;
      a.deletions += e.deletions || 0;
    }
    if (e.session) a.sessions.add(e.session);
    if (e.ts < a.first) a.first = e.ts;
    if (e.ts > a.last) a.last = e.ts;
  }
  const agents = [...byAgent.values()]
    .map((a) => ({ ...a, sessions: a.sessions.size }))
    .sort((x, y) => (x.last < y.last ? 1 : -1));

  if (json) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }
  if (agents.length === 0) {
    console.log(dim("no operations recorded yet."));
    return;
  }
  console.log(bold(`stord agents — ${agents.length} identit${agents.length === 1 ? "y" : "ies"}`));
  console.log();
  const width = Math.max(...agents.map((a) => a.agent.length), 5);
  for (const a of agents) {
    const name = a.agent === "(unattributed)" ? yellow(a.agent.padEnd(width)) : magenta(a.agent.padEnd(width));
    const opsPlain = `${a.ops} op${a.ops === 1 ? "" : "s"}` +
      (a.reads ? ` ${a.reads} read${a.reads === 1 ? "" : "s"}` : "") +
      (a.undos ? ` ${a.undos} undo/restore` : "");
    const lines = `${green(`+${a.insertions}`)} ${red(`-${a.deletions}`)}`;
    const sess = a.sessions ? `${a.sessions} session${a.sessions === 1 ? "" : "s"}` : dim("—");
    const last = dim(`last ${a.last.replace("T", " ").replace(/\.\d+Z$/, "Z")}`);
    console.log(`  ${name}  ${opsPlain.padEnd(20)}  ${lines}  ${sess}  ${last}`);
  }
  console.log();
  console.log(dim(`stord log --agent <name> for one agent's timeline`));
}

// ---------------------------------------------------------------------------
// undo / restore
// ---------------------------------------------------------------------------

function cmdUndo(args) {
  const root = requireRoot();
  const force = args.includes("--force");
  const id = args.find((a) => !a.startsWith("-")) || "last";
  const e = findEntry(root, id);
  if (!e) { console.error(red(`no journal entry matching "${id}"`)); process.exit(1); }
  if (e.kind === "read") { console.error(red("read events change nothing — there is nothing to undo.")); process.exit(1); }
  if (!e.pre) { console.error(red("cannot undo the baseline entry.")); process.exit(1); }
  if (e.kind === "undo" || e.kind === "restore") {
    console.error(yellow(`note: ${e.id} is itself an ${e.kind}; undoing it re-applies the original change.`));
  }

  // journal any outstanding drift first so undo is cleanly attributable
  const drift = snapshot(root, "external change");
  if (drift && drift.pre) makeEntry(root, "external", drift, { note: "changes captured before undo" });

  // reverse-apply the op's diff
  const patch = shadowOk(root, ["diff", "--binary", e.post, e.pre]);
  if (!patch.trim()) { console.log(dim("nothing to undo — diff is empty.")); return; }

  const apply = shadow(root, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch });
  if (apply.status !== 0) {
    if (!force) {
      console.error(red("✗ clean undo failed — later operations touched the same files."));
      console.error(dim(String(apply.stderr).trim()));
      console.error();
      console.error(`  ${cyan(`stord undo ${e.id} --force`)}   restore those files to their pre-op state ${yellow("(discards later edits to them)")}`);
      console.error(`  ${cyan(`stord restore --before ${e.id}`)}   roll the WHOLE tree back to before this op`);
      process.exit(1);
    }
    // force: per-file restore to pre-op state
    const status = shadowOk(root, ["diff", "--name-status", e.pre, e.post]);
    for (const line of status.split("\n")) {
      if (!line.trim()) continue;
      const [flag, ...rest] = line.split("\t");
      const file = rest[rest.length - 1];
      if (flag.startsWith("A")) {
        rmSync(join(root, file), { force: true }); // op created it → remove
      } else {
        shadowOk(root, ["checkout", e.pre, "--", flag.startsWith("R") ? rest[0] : file]);
        if (flag.startsWith("R")) rmSync(join(root, file), { force: true });
      }
    }
  }

  const snap = snapshot(root, `undo ${e.id}`);
  if (snap && snap.pre) {
    const entry = makeEntry(root, "undo", snap, { target: e.id, agent: process.env.STORD_AGENT || null });
    console.log(green(`✓ undid ${e.id}`) + ` (${describe(e)})`);
    console.log(`  recorded as ${cyan(entry.id)} — ${statStr(entry)}`);
  } else {
    console.log(dim("nothing changed."));
  }
}

function cmdRestore(args) {
  const root = requireRoot();
  const before = argValue(args, "--before");
  const to = argValue(args, "--to");
  const id = before || to;
  if (!id) {
    console.error(red("usage: stord restore --before <id>   (tree state just before that op)"));
    console.error(red("       stord restore --to <id>       (tree state just after that op)"));
    process.exit(1);
  }
  const e = findEntry(root, id);
  if (!e) { console.error(red(`no journal entry matching "${id}"`)); process.exit(1); }
  const commit = before ? e.pre : e.post;
  if (!commit) { console.error(red("baseline has no pre-state.")); process.exit(1); }

  const drift = snapshot(root, "external change");
  if (drift && drift.pre) makeEntry(root, "external", drift, { note: "changes captured before restore" });

  shadowOk(root, ["read-tree", "-u", "--reset", commit]);

  const snap = snapshot(root, `restore ${before ? "before" : "to"} ${e.id}`);
  if (snap && snap.pre) {
    const entry = makeEntry(root, "restore", snap, {
      target: e.id,
      mode: before ? "before" : "to",
      agent: process.env.STORD_AGENT || null,
    });
    console.log(green(`✓ restored tree to ${before ? "before" : "after"} ${e.id}`));
    console.log(`  recorded as ${cyan(entry.id)} — ${statStr(entry)}`);
  } else {
    console.log(dim("tree already matched that state — nothing changed."));
  }
}

// ---------------------------------------------------------------------------
// watch (for agents without hooks, e.g. codex)
// ---------------------------------------------------------------------------

function cmdWatch(args) {
  const root = requireRoot();
  const interval = Math.max(1, Number(argValue(args, "--interval") || 2)) * 1000;
  const agent = argValue(args, "--agent") || process.env.STORD_AGENT || "watch";
  console.log(bold(`stord watch`) + dim(` — journaling changes in ${root} every ${interval / 1000}s (^C to stop)`));

  // capture anything pending before we start
  const initial = snapshot(root, "pre-watch state");
  if (initial && initial.pre) makeEntry(root, "external", initial, { note: "changes before watch started" });

  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    try {
      if (!snapshotDryRun(root)) return;
      const files = shadow(root, ["status", "--porcelain"]).stdout
        .split("\n").filter(Boolean).map((l) => l.slice(3)).slice(0, 3);
      const snap = snapshot(root, `watched change: ${files.join(", ")}`);
      if (snap && snap.pre) {
        const entry = makeEntry(root, "watch", snap, {
          agent,
          summary: files.join(", ") + (snap.files > files.length ? ` (+${snap.files - files.length} more)` : ""),
        });
        console.log(`  ${cyan(entry.id)}  ${dim(new Date().toLocaleTimeString())}  ${statStr(entry)}  ${dim(entry.summary)}`);
      }
    } catch (err) {
      console.error(red(`watch error: ${err.message}`));
    } finally {
      busy = false;
    }
  };
  setInterval(tick, interval);
  process.on("SIGINT", () => { console.log(dim("\nwatch stopped. `stord log` to review.")); process.exit(0); });
}

// ---------------------------------------------------------------------------
// ui (local journal viewer)
// ---------------------------------------------------------------------------

const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stord — agent flight recorder</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#21262d; --fg:#e6edf3; --dim:#8b949e;
          --accent:#f0883e; --green:#3fb950; --red:#f85149; --mag:#d2a8ff; --cyan:#79c0ff; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; padding:24px; }
  header { display:flex; align-items:baseline; gap:12px; margin-bottom:18px; flex-wrap:wrap; }
  h1 { font-size:18px; } h1 b { color:var(--accent); }
  .meta { color:var(--dim); font-size:12px; }
  .filters { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
  .chip { background:var(--panel); border:1px solid var(--line); border-radius:999px;
          padding:3px 12px; cursor:pointer; color:var(--dim); font-size:12px; }
  .chip.on { color:var(--fg); border-color:var(--accent); }
  .entry { background:var(--panel); border:1px solid var(--line); border-radius:8px;
           padding:8px 12px; margin-bottom:6px; }
  .entry.clickable { cursor:pointer; }
  .entry.clickable:hover { border-color:var(--accent); }
  .row { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
  .id { color:var(--cyan); } .ts { color:var(--dim); font-size:12px; }
  .agent { color:var(--mag); } .sess { color:var(--dim); font-size:11px; }
  .kind { font-size:11px; border-radius:4px; padding:1px 6px; border:1px solid var(--line); color:var(--dim); }
  .kind.read { color:var(--cyan); } .kind.tool { color:var(--green); }
  .kind.undo,.kind.restore { color:var(--red); } .kind.external,.kind.watch { color:var(--accent); }
  .what { flex:1; min-width:200px; word-break:break-all; }
  .stat { font-size:12px; } .stat .add { color:var(--green); } .stat .del { color:var(--red); }
  pre.diff { background:var(--bg); border-top:1px solid var(--line); margin-top:8px;
             padding:10px; overflow-x:auto; font-size:12px; display:none; }
  pre.diff .add { color:var(--green); } pre.diff .del { color:var(--red); } pre.diff .hunk { color:var(--cyan); }
  .empty { color:var(--dim); padding:40px; text-align:center; }
</style>
</head>
<body>
<header>
  <h1><b>stord</b> — agent flight recorder</h1>
  <span class="meta" id="meta"></span>
</header>
<div class="filters" id="filters"></div>
<div id="list"></div>
<script>
let showReads = true, agentFilter = null, entries = [], openDiffs = new Set();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function colorDiff(text) {
  return esc(text).split("\\n").map((l) => {
    if (l.startsWith("+") && !l.startsWith("+++")) return '<span class="add">' + l + "</span>";
    if (l.startsWith("-") && !l.startsWith("---")) return '<span class="del">' + l + "</span>";
    if (l.startsWith("@@")) return '<span class="hunk">' + l + "</span>";
    return l;
  }).join("\\n");
}
function render() {
  const agents = [...new Set(entries.map((e) => e.agent).filter(Boolean))];
  document.getElementById("filters").innerHTML =
    '<span class="chip" id="readtoggle">reads: ' + (showReads ? "on" : "off") + "</span>" +
    '<span class="chip' + (agentFilter === null ? " on" : "") + '" data-agent="">all agents</span>' +
    agents.map((a) => '<span class="chip' + (agentFilter === a ? " on" : "") + '" data-agent="' + esc(a) + '">' + esc(a) + "</span>").join("");
  document.getElementById("readtoggle").onclick = () => { showReads = !showReads; render(); };
  for (const chip of document.querySelectorAll(".chip[data-agent]"))
    chip.onclick = () => { agentFilter = chip.dataset.agent || null; render(); };

  let shown = entries.filter((e) => e.kind !== "baseline");
  if (!showReads) shown = shown.filter((e) => e.kind !== "read");
  if (agentFilter) shown = shown.filter((e) => e.agent === agentFilter);
  shown = shown.slice().reverse();

  document.getElementById("meta").textContent =
    shown.length + " events · " + agents.length + " agent" + (agents.length === 1 ? "" : "s");

  document.getElementById("list").innerHTML = shown.length === 0
    ? '<div class="empty">no events recorded yet — run an agent in this project</div>'
    : shown.map((e) => {
        const hasDiff = e.pre && e.post;
        const files = (e.files && Array.isArray(e.files)) ? e.files.join(", ") : "";
        const what = e.kind === "read" ? (files || e.summary || "")
          : e.kind === "tool" ? (e.tool || "") + " " + (e.summary || "")
          : e.kind === "undo" ? "undo of " + e.target
          : e.kind === "restore" ? "restore to " + (e.mode === "before" ? "before " : "") + e.target
          : (e.summary || e.note || e.kind);
        const stat = e.kind === "read" ? "" :
          '<span class="stat">' + (e.files && typeof e.files === "number" ? e.files + " files " : "") +
          (e.insertions ? '<span class="add">+' + e.insertions + "</span> " : "") +
          (e.deletions ? '<span class="del">-' + e.deletions + "</span>" : "") + "</span>";
        return '<div class="entry' + (hasDiff ? " clickable" : "") + '" data-id="' + esc(e.id) + '">' +
          '<div class="row">' +
            '<span class="kind ' + esc(e.kind) + '">' + esc(e.kind) + "</span>" +
            '<span class="ts">' + esc((e.ts || "").replace("T", " ").replace(/\\.\\d+Z$/, "")) + "</span>" +
            (e.agent ? '<span class="agent">' + esc(e.agent) + "</span>" : (e.user ? '<span class="agent">' + esc(e.user) + "</span>" : "")) +
            (e.session ? '<span class="sess">#' + esc(e.session.slice(0, 8)) + "</span>" : "") +
            '<span class="what">' + esc(what) + "</span>" + stat +
            '<span class="id">' + esc(e.id) + "</span>" +
          "</div>" +
          (hasDiff ? '<pre class="diff" id="diff-' + esc(e.id) + '"' + (openDiffs.has(e.id) ? ' style="display:block"' : "") + "></pre>" : "") +
        "</div>";
      }).join("");

  for (const el of document.querySelectorAll(".entry.clickable")) {
    el.onclick = async () => {
      const id = el.dataset.id;
      const pre = document.getElementById("diff-" + id);
      if (pre.style.display === "block") { pre.style.display = "none"; openDiffs.delete(id); return; }
      if (!pre.dataset.loaded) {
        pre.innerHTML = "loading…";
        const text = await (await fetch("/api/diff?id=" + encodeURIComponent(id))).text();
        pre.innerHTML = colorDiff(text);
        pre.dataset.loaded = "1";
      }
      pre.style.display = "block";
      openDiffs.add(id);
    };
  }
  for (const id of openDiffs) {
    const pre = document.getElementById("diff-" + id);
    if (pre && !pre.dataset.loaded) {
      fetch("/api/diff?id=" + encodeURIComponent(id)).then((r) => r.text()).then((t) => {
        pre.innerHTML = colorDiff(t); pre.dataset.loaded = "1";
      });
    }
  }
}
async function refresh() {
  try {
    entries = await (await fetch("/api/journal")).json();
    render();
  } catch { /* server gone */ }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

function cmdUi(args) {
  const root = requireRoot();
  const port = Number(argValue(args, "--port") || 4983);

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/journal") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(journalRead(root)));
      return;
    }
    if (url.pathname === "/api/diff") {
      const e = journalRead(root).find((x) => x.id === url.searchParams.get("id"));
      if (!e || !e.pre || !e.post) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("no diff for that entry");
        return;
      }
      const r = shadow(root, ["diff", "--color=never", "--stat", "-p", e.pre, e.post]);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(r.stdout || "(empty diff)");
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(UI_HTML);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // journal contents are sensitive — never expose beyond this machine
  server.listen(port, "127.0.0.1", () => {
    console.log(bold("stord ui") + ` — http://127.0.0.1:${port}  ${dim("(^C to stop)")}`);
  });
  server.on("error", (err) => {
    console.error(red(`ui server error: ${err.message}`));
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// help / main
// ---------------------------------------------------------------------------

function cmdHelp() {
  console.log(`${bold("stord")} — audit + undo for AI agent file operations

${bold("setup")}
  stord enable              set up shadow journal + Claude Code hooks (run in project root)
  stord disable             remove the hooks (journal is kept)
  stord status              what's protected, what's recorded

${bold("audit")}
  stord log                 timeline of every operation agents performed
       --all  -n <N>  --json  --session <id>  --agent <name>  --reads
  stord show <id>           full diff of one operation
  stord agents              every identity in the journal: ops, reads, lines, last seen
  stord ui [--port <p>]     local web UI over the journal (default http://127.0.0.1:4983)

${bold("recover")}
  stord undo [<id>|last]    reverse a single operation (clean reverse-patch)
       --force              clobber later edits to those files if patch conflicts
  stord restore --before <id>   roll the entire tree back to just before an op
  stord restore --to <id>       roll the entire tree to just after an op

${bold("other agents (codex, hermes, openclaw, custom)")}
  stord hook post --agent <name>    wire into the agent's own PostToolUse-style hook
  stord event read --file <p> --agent <name>    record a read from any script/plugin
  stord watch [--interval <s>] [--agent <name>] journal changes for hook-less agents (writes only)

${bold("identity")}
  Every entry records who acted: agent name, session, and OS user.
  Name an agent for a run:  ${cyan("STORD_AGENT=deploy-bot claude --dangerously-skip-permissions")}

${dim("How: a shadow git repo in .stord/ snapshots your worktree around every agent")}
${dim("tool call; reads are journaled as lightweight events from hooks. Your real")}
${dim("git repo and history are never touched.")}`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "enable": cmdEnable(); break;
  case "disable": cmdDisable(); break;
  case "status": cmdStatus(); break;
  case "log": cmdLog(rest); break;
  case "show": case "diff": cmdShow(rest); break;
  case "agents": cmdAgents(rest); break;
  case "undo": cmdUndo(rest); break;
  case "restore": cmdRestore(rest); break;
  case "watch": cmdWatch(rest); break;
  case "ui": cmdUi(rest); break;
  case "event": cmdEvent(rest); break;
  case "hook": cmdHook(rest[0] === "post" ? "post" : "pre", rest.slice(1)); break;
  case "help": case "--help": case "-h": case undefined: cmdHelp(); break;
  default:
    console.error(red(`unknown command: ${cmd}`));
    cmdHelp();
    process.exit(1);
}
