#!/usr/bin/env node
// Import Claude Code + Codex chat history into a vault's raw/ folder as clean
// markdown — one file per session, tool-noise stripped. Mechanical only (no LLM):
// stage the raw material, then let your agent self-ingest raw/ → wiki/ in batches.
//
// Usage:
//   node import-chats.mjs <vault> [--source claude|codex|both] [--limit N] [--dry-run]
//
// Sources:
//   claude  ~/.claude/projects/**/*.jsonl
//   codex   ~/.codex/sessions + ~/.codex/archived_sessions/rollout-*.jsonl
//
// Zero dependencies. Skips sessions that yield no real conversational turns.

import { createReadStream, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
import { homedir } from "node:os";

/** Short stable hash of a string — keeps filenames unique + re-runs idempotent. */
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

const args = process.argv.slice(2);
const vault = args.find((a) => !a.startsWith("--"));
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

if (!vault) {
  console.error("usage: node import-chats.mjs <vault> [--source claude|codex|both] [--limit N] [--dry-run]");
  process.exit(1);
}
const SOURCE = flag("source", "both");
const LIMIT = Number(flag("limit", "0")) || Infinity;
const DRY = has("dry-run");
const RAW = join(vault, "raw");

// ── helpers ──────────────────────────────────────────────────────────────────

function slugify(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "untitled";
}

/** Strip CC/system wrapper blocks; return "" if nothing conversational remains. */
function cleanUserText(text) {
  if (typeof text !== "string") return "";
  const stripped = text
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, "")
    .replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<[^>]*-caveat>[\s\S]*?<\/[^>]*-caveat>/g, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/^Shell cwd was reset to .*$/gm, "")
    .trim();
  return stripped;
}

/** Pull readable text out of an assistant/user content value (string or block list). */
function blocksToText(content, kind /* "user" | "assistant" */) {
  if (typeof content === "string") return kind === "user" ? cleanUserText(content) : content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (b?.type === "text" && b.text) parts.push(kind === "user" ? cleanUserText(b.text) : b.text);
    else if (b?.type === "input_text" && b.text) parts.push(cleanUserText(b.text));
    else if (b?.type === "output_text" && b.text) parts.push(b.text);
    // skip thinking / tool_use / tool_result / function_call — that's the noise
  }
  return parts.join("\n").trim();
}

async function eachLine(file, onObj) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    onObj(o);
  }
}

function writeSession({ source, id, title, project, date, turns, src }) {
  const real = turns.filter((t) => t.text);
  if (real.length < 1) return false; // nothing conversational — skip
  const slug = slugify(title || project || id);
  // shortHash(src) guarantees uniqueness — resumed sessions share an id but not a file.
  const name = `${source}-${(date || "").slice(0, 10) || "nodate"}-${slug}-${shortHash(src)}.md`;
  const fm = [
    "---",
    `source: ${source}`,
    `session: ${id || ""}`,
    `project: ${project || ""}`,
    `date: ${date || ""}`,
    `turns: ${real.length}`,
    "---",
    "",
    `# ${title || project || "Untitled session"}`,
    "",
  ];
  const body = real.map((t) => `## ${t.role === "user" ? "👤 User" : "🤖 Assistant"}\n\n${t.text}`).join("\n\n");
  if (!DRY) writeFileSync(join(RAW, name), fm.join("\n") + body + "\n", "utf8");
  return true;
}

// ── Claude Code ──────────────────────────────────────────────────────────────

function listClaudeFiles() {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

async function importClaude(file) {
  let title = "", project = "", date = "", id = "";
  const turns = [];
  await eachLine(file, (o) => {
    if (o.type === "ai-title" && o.aiTitle) title = o.aiTitle;
    if (o.sessionId && !id) id = o.sessionId;
    if (o.cwd && !project) project = basename(o.cwd);
    if (o.timestamp && !date) date = o.timestamp;
    if (o.type === "user" || o.type === "assistant") {
      const text = blocksToText(o.message?.content, o.type);
      if (text) turns.push({ role: o.type, text });
    }
  });
  return writeSession({ source: "claude-code", id: id || basename(file, ".jsonl"), title, project, date, turns, src: file });
}

// ── Codex ────────────────────────────────────────────────────────────────────

function listCodexFiles() {
  const dirs = [join(homedir(), ".codex", "sessions"), join(homedir(), ".codex", "archived_sessions")];
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.startsWith("rollout-") && f.endsWith(".jsonl")) out.push(p);
      }
    };
    walk(dir);
  }
  return out;
}

async function importCodex(file) {
  let project = "", date = "", id = "";
  const turns = [];
  await eachLine(file, (o) => {
    if (o.type === "session_meta") {
      id = o.payload?.id || id;
      date = o.payload?.timestamp || date;
      project = o.payload?.cwd ? basename(o.payload.cwd) : project;
      return;
    }
    if (o.type === "response_item" && o.payload?.type === "message") {
      const role = o.payload.role;
      if (role !== "user" && role !== "assistant") return;
      const text = blocksToText(o.payload.content, role === "user" ? "user" : "assistant");
      // drop the AGENTS.md / system preamble that opens most codex sessions
      if (text && !text.startsWith("# AGENTS.md instructions")) turns.push({ role, text });
    }
  });
  return writeSession({ source: "codex", id: id || basename(file, ".jsonl"), title: "", project, date, turns, src: file });
}

// ── run ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!DRY) mkdirSync(RAW, { recursive: true });
  const jobs = [];
  if (SOURCE === "claude" || SOURCE === "both") jobs.push(...listClaudeFiles().map((f) => ["claude", f]));
  if (SOURCE === "codex" || SOURCE === "both") jobs.push(...listCodexFiles().map((f) => ["codex", f]));

  let written = 0, skipped = 0, n = 0;
  for (const [kind, f] of jobs) {
    if (n >= LIMIT) break;
    n++;
    try {
      const ok = kind === "claude" ? await importClaude(f) : await importCodex(f);
      ok ? written++ : skipped++;
    } catch (err) {
      skipped++;
      if (DRY) console.error(`  ! ${basename(f)}: ${err.message}`);
    }
  }
  console.log(`${DRY ? "[dry-run] " : ""}scanned ${n} sessions → ${written} written, ${skipped} skipped (empty/unparseable)`);
  if (!DRY) console.log(`  → ${RAW}`);
}

run();
