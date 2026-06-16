#!/usr/bin/env node
// Import a Netscape bookmarks export (Chrome/Firefox/Safari "Export Bookmarks")
// into a vault's wiki/bookmarks/ — one markdown page per top-level folder, links
// grouped by sub-folder, base64 icons + javascript: bookmarklets stripped.
// Mechanical (no LLM): bookmarks are already structured reference, so they go
// straight to wiki/ instead of raw/ (distilling a link list wastes tokens).
//
// Usage:
//   node import-bookmarks.mjs <vault> <bookmarks.html> [--dry-run]

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [vault, htmlPath] = positional;
const DRY = args.includes("--dry-run");

if (!vault || !htmlPath) {
  console.error("usage: node import-bookmarks.mjs <vault> <bookmarks.html> [--dry-run]");
  process.exit(1);
}
if (!existsSync(htmlPath)) { console.error(`not found: ${htmlPath}`); process.exit(1); }

const OUT = join(vault, "wiki", "bookmarks");

function slugify(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
}

// Topic classifier — first match wins, so order = priority (most specific first).
// Tuned to this corpus's signal: AI/agents/Claude dominate, then design, frontend, tooling.
const TOPICS = [
  ["AI Agents", /\b(agent|agents|agentic|swarm|multi-agent|autonomous|voltagent|copilotkit|multiplexer|a2a)\b/i],
  ["Claude · MCP · Skills", /\b(claude|mcp|skills?|codex|cursor|anthropic|openclaw|windsurf|hermes|opencode|spec-kit|spec-driven)\b/i],
  ["LLM · Prompts · Models", /\b(llm|gpt|prompts?|deepseek|gemma|qwen|\brag\b|tts|embeddings?|gemini|mlx|ollama|fine-?tun|diffusion|hugging ?face)\b/i],
  ["Design · UI Kits", /\b(design|ui ?kits?|figma|shadcn|components?|icons?|fonts?|colou?rs?|tokens?|wireframe|mockup|illustration|svgl?|logos?|gradient|palette|oklch|\bhex\b|brand(fetch|ing)?)\b/i],
  ["Studios · Agencies · Inspiration", /\b(agenc(y|ies)|studios?|galler(y|ies)|inspiration|showcase|awwwards|portfolio|brutalis[mt]|neo-?brutal|creative)\b/i],
  ["Frontend · 3D · Motion", /\b(react|next\.?js|vue|svelte|tailwind|\bcss\b|\bhtml\b|three\.?js|webgl|shader|gsap|motion|animation|rive|canvas|hero sections?)\b/i],
  ["Dev Tools · CLI · Infra", /\b(cli|terminal|docker|self-?host|\bapi\b|dashboard|\bsdk\b|node|rust|python|swift|ios|sqlite|kanban|workflow|boilerplate|template|alternative|headless|prox(y|ies)|\bvpn\b|firecrawl)\b/i],
  ["Scrapers · Downloads · Utilities", /\b(scraper|scrape|downloader?|torrent|crack|nulled|browser-use|playwright|stealth|osint|archive|udemy)\b/i],
];
function classify(text) {
  for (const [label, re] of TOPICS) if (re.test(text)) return label;
  return "Other";
}
function decode(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function isKeepable(href) {
  return /^https?:\/\//i.test(href); // skip javascript: bookmarklets, data:, place:, etc.
}

/** Parse the Netscape bookmark tree into { folderPath: [{title, url, date}] }. */
function parse(html) {
  const lines = html.split("\n");
  const stack = [];        // folder-name stack
  let pending = null;      // H3 name awaiting its <DL>
  const byFolder = new Map();
  const add = (path, item) => {
    const key = path.join(" / ") || "Uncategorized";
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(item);
  };
  for (const line of lines) {
    const h3 = line.match(/<H3[^>]*>(.*?)<\/H3>/i);
    if (h3) { pending = decode(h3[1].trim()); continue; }
    if (/<DL>/i.test(line)) { stack.push(pending ?? "Bookmarks"); pending = null; continue; }
    if (/<\/DL>/i.test(line)) { stack.pop(); continue; }
    const a = line.match(/<A\s+HREF="([^"]*)"([^>]*)>(.*?)<\/A>/i);
    if (a) {
      const href = decode(a[1]);
      if (!isKeepable(href)) continue;
      const addDate = (a[2].match(/ADD_DATE="(\d+)"/i) || [])[1];
      const date = addDate ? new Date(Number(addDate) * 1000).toISOString().slice(0, 10) : "";
      add(stack, { title: decode(a[3].trim()) || href, url: href, date });
    }
  }
  return byFolder;
}

/** A link is a GitHub repo if its host is github.com / gist.github.com. */
function isGithub(url) {
  return /^https?:\/\/(www\.)?(gist\.)?github\.com\//i.test(url);
}

/** De-dupe by URL, keeping the first-seen (earliest folder) title. */
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

/** Render a type-page (github | sites): links grouped by inferred topic. */
function renderPage(heading, slug, items, date) {
  const byTopic = new Map();
  for (const it of items) {
    const topic = classify(`${it.title} ${it.url}`);
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(it);
  }
  const order = [...TOPICS.map((t) => t[0]), "Other"];
  const present = order.filter((t) => byTopic.has(t));
  const tags = ["bookmarks", slug, ...present.filter((t) => t !== "Other").map(slugify)];
  const out = [
    "---",
    `tags: [${tags.join(", ")}]`,
    "type: source",
    `created: ${date}`,
    `count: ${items.length}`,
    "---",
    "",
    `# Bookmarks — ${heading}`,
    "",
  ];
  for (const topic of present) {
    const group = byTopic.get(topic);
    out.push(`## ${topic} (${group.length})`, "");
    for (const it of group.sort((a, b) => a.title.localeCompare(b.title))) {
      out.push(`- [${it.title}](${it.url})${it.date ? ` _(added ${it.date})_` : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}

const html = readFileSync(htmlPath, "utf8");
const allItems = dedupe([...parse(html).values()].flat());
const repos = allItems.filter((it) => isGithub(it.url));
const sites = allItems.filter((it) => !isGithub(it.url));
const today = new Date().toISOString().slice(0, 10);

// Type-first split (github repos vs websites), each topic-grouped — the original
// bookmark folders mixed both, so URL is the reliable axis.
const PAGES = [
  ["GitHub Repos", "github", repos],
  ["Sites", "sites", sites],
];

if (!DRY) mkdirSync(OUT, { recursive: true });
const indexLines = ["# Bookmarks", "", `*Imported ${today}.*`, ""];
for (const [heading, slug, items] of PAGES) {
  if (!DRY) writeFileSync(join(OUT, `${slug}.md`), renderPage(heading, slug, items, today), "utf8");
  indexLines.push(`- [[${slug}|Bookmarks — ${heading}]] — ${items.length} links`);
  console.log(`  ${DRY ? "[dry] " : ""}${(slug + ".md").padEnd(14)} ${items.length} links`);
}
if (!DRY) writeFileSync(join(OUT, "_index.md"), indexLines.join("\n") + "\n", "utf8");
console.log(`${DRY ? "[dry-run] " : ""}${PAGES.length} pages, ${allItems.length} links → ${OUT}`);
