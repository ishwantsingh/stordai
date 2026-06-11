/**
 * Smoke test for the stord CLI: enable → simulated agent ops via hook
 * payloads → log → undo → restore. Runs in a temp dir, no framework needed.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const STORD = fileURLToPath(new URL("../bin/stord.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "stord-smoke-"));

const baseEnv = { ...process.env };
delete baseEnv.STORD_AGENT; // a developer's own identity must not leak into assertions

function stord(args, input, env = {}) {
  const r = spawnSync(process.execPath, [STORD, ...args], {
    cwd: dir, encoding: "utf8", input, env: { ...baseEnv, ...env },
  });
  return r;
}
function hook(phase, tool, toolInput, env = {}) {
  const payload = JSON.stringify({ session_id: "smoke-session", cwd: dir, tool_name: tool, tool_input: toolInput });
  const r = stord(["hook", phase], payload, env);
  assert.equal(r.status, 0, `hook ${phase} exited ${r.status}: ${r.stderr}`);
}

try {
  // setup project
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/app.js"), "console.log('v1');\n");
  spawnSync("git", ["init", "-q"], { cwd: dir });

  // enable
  const en = stord(["enable"]);
  assert.equal(en.status, 0, en.stderr);
  assert.ok(existsSync(join(dir, ".stord/shadow.git")), "shadow repo created");
  assert.ok(readFileSync(join(dir, ".claude/settings.local.json"), "utf8").includes("hook pre"), "hooks installed");
  assert.ok(readFileSync(join(dir, ".gitignore"), "utf8").includes(".stord/"), "gitignored");

  // op 1: agent edit
  hook("pre", "Edit", { file_path: join(dir, "src/app.js") });
  writeFileSync(join(dir, "src/app.js"), "console.log('v2');\n");
  hook("post", "Edit", { file_path: join(dir, "src/app.js") });

  // op 2: destructive bash, run by a named agent (STORD_AGENT override)
  hook("pre", "Bash", { command: "rm src/app.js" }, { STORD_AGENT: "smoke-bot" });
  rmSync(join(dir, "src/app.js"));
  hook("post", "Bash", { command: "rm src/app.js" }, { STORD_AGENT: "smoke-bot" });

  // log has both ops, each attributed to an identity
  const log = stord(["log", "--json", "--all"]);
  const entries = JSON.parse(log.stdout);
  const tools = entries.filter((e) => e.kind === "tool");
  assert.equal(tools.length, 2, `expected 2 tool ops, got ${tools.length}`);
  assert.equal(tools[0].tool, "Edit");
  assert.equal(tools[0].agent, "claude-code", "hook default identity");
  assert.ok(tools[0].user, "OS user recorded");
  assert.equal(tools[1].tool, "Bash");
  assert.equal(tools[1].summary, "rm src/app.js");
  assert.equal(tools[1].agent, "smoke-bot", "STORD_AGENT names the agent");

  // --agent filters the timeline to one identity
  const botLog = JSON.parse(stord(["log", "--json", "--all", "--agent", "smoke-bot"]).stdout);
  assert.equal(botLog.length, 1, "agent filter isolates one identity");
  assert.equal(botLog[0].agent, "smoke-bot");

  // reads: Claude Code Read tool → lightweight read event, no snapshot
  hook("post", "Read", { file_path: join(dir, "src/app.js") });
  // reads: Codex-style payload (different field names) via stord hook --agent
  const codexPayload = JSON.stringify({
    workdir: dir, thread_id: "codex-thread-1", tool: "read_file", input: { path: join(dir, ".env") },
  });
  const ch = stord(["hook", "post", "--agent", "codex"], codexPayload);
  assert.equal(ch.status, 0, ch.stderr);
  // reads: generic ingestion for any other agent (hermes/openclaw/custom)
  const ev = stord(["event", "read", "--file", join(dir, "secrets.txt"), "--agent", "hermes", "--tool", "read_file"]);
  assert.equal(ev.status, 0, ev.stderr);

  const reads = JSON.parse(stord(["log", "--json", "--all"]).stdout).filter((e) => e.kind === "read");
  assert.equal(reads.length, 3, `expected 3 read events, got ${reads.length}`);
  assert.equal(reads[0].agent, "claude-code");
  assert.deepEqual(reads[0].files, [join(dir, "src/app.js")]);
  assert.equal(reads[1].agent, "codex", "codex payload normalized");
  assert.equal(reads[1].session, "codex-thread-1", "codex thread id mapped to session");
  assert.equal(reads[2].agent, "hermes");

  // log hides reads by default; --reads includes them
  const defaultLog = JSON.parse(stord(["log", "--json"]).stdout);
  assert.ok(!defaultLog.some((e) => e.kind === "read"), "reads hidden by default");
  const readsLog = JSON.parse(stord(["log", "--json", "--reads"]).stdout);
  assert.ok(readsLog.some((e) => e.kind === "read"), "--reads shows them");

  // reads cannot be undone
  const badUndo = stord(["undo", reads[0].id]);
  assert.notEqual(badUndo.status, 0, "undo of a read must fail");

  // undo the delete
  const undo = stord(["undo", tools[1].id]);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(readFileSync(join(dir, "src/app.js"), "utf8"), "console.log('v2');\n", "delete undone");

  // restore to before everything
  const restore = stord(["restore", "--before", tools[0].id]);
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(readFileSync(join(dir, "src/app.js"), "utf8"), "console.log('v1');\n", "tree restored to baseline");

  // undo + restore are themselves journaled, attributed to the OS user
  const log2 = JSON.parse(stord(["log", "--json", "--all"]).stdout);
  const undoEntry = log2.find((e) => e.kind === "undo");
  assert.ok(undoEntry, "undo journaled");
  assert.ok(undoEntry.user, "undo attributed to OS user");
  assert.ok(log2.some((e) => e.kind === "restore"), "restore journaled");

  // agents command aggregates per identity, reads counted separately
  const agents = JSON.parse(stord(["agents", "--json"]).stdout);
  const byName = Object.fromEntries(agents.map((a) => [a.agent, a]));
  assert.ok(byName["claude-code"], "claude-code identity listed");
  assert.equal(byName["claude-code"].ops, 1);
  assert.equal(byName["claude-code"].reads, 1);
  assert.equal(byName["claude-code"].sessions, 1);
  assert.ok(byName["smoke-bot"], "named agent listed");
  assert.equal(byName["smoke-bot"].ops, 1);
  assert.equal(byName["codex"].reads, 1, "codex reads counted");
  assert.equal(byName["hermes"].reads, 1, "hermes reads counted");
  const userKey = Object.keys(byName).find((k) => k.startsWith("user:"));
  assert.ok(userKey, "recovery actions grouped under the OS user");
  assert.equal(byName[userKey].undos, 2, "undo + restore counted for the user");

  // ui server: serves the page, the journal, and a diff
  const port = 49100 + (process.pid % 400);
  const ui = spawn(process.execPath, [STORD, "ui", "--port", String(port)], { cwd: dir, env: baseEnv });
  try {
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      up = await fetch(`http://127.0.0.1:${port}/api/journal`).then((r) => r.ok).catch(() => false);
    }
    assert.ok(up, "ui server came up");
    const journal = await (await fetch(`http://127.0.0.1:${port}/api/journal`)).json();
    assert.ok(journal.some((e) => e.kind === "read"), "ui journal includes reads");
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(html.includes("flight recorder"), "ui page served");
    const withDiff = journal.find((e) => e.kind === "tool");
    const diff = await (await fetch(`http://127.0.0.1:${port}/api/diff?id=${withDiff.id}`)).text();
    assert.ok(diff.includes("app.js"), "ui serves diffs");
  } finally {
    ui.kill();
  }

  // disable removes hooks but keeps journal
  stord(["disable"]);
  assert.ok(!readFileSync(join(dir, ".claude/settings.local.json"), "utf8").includes("stord.mjs"), "hooks removed");
  assert.ok(existsSync(join(dir, ".stord/journal.jsonl")), "journal kept");

  console.log("✓ stord smoke test passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
