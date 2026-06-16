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

/** Group folder paths under their top-level category (drop the root "Bookmarks" wrapper). */
function byTopLevel(byFolder) {
  const tops = new Map();
  for (const [path, items] of byFolder) {
    const parts = path.split(" / ").filter((p) => p && p.toLowerCase() !== "bookmarks");
    const top = parts[0] || "Uncategorized";
    const sub = parts.slice(1).join(" / ") || "(top level)";
    if (!tops.has(top)) tops.set(top, new Map());
    tops.get(top).set(sub, items);
  }
  return tops;
}

function pageFor(top, subMap, date) {
  const total = [...subMap.values()].reduce((n, x) => n + x.length, 0);
  const out = [
    "---",
    `tags: [bookmarks, ${slugify(top)}]`,
    "type: source",
    `created: ${date}`,
    `count: ${total}`,
    "---",
    "",
    `# Bookmarks — ${top}`,
    "",
  ];
  for (const [sub, items] of subMap) {
    if (sub !== "(top level)") out.push(`## ${sub}`, "");
    for (const it of items.sort((a, b) => a.title.localeCompare(b.title))) {
      out.push(`- [${it.title}](${it.url})${it.date ? ` _(added ${it.date})_` : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}

const html = readFileSync(htmlPath, "utf8");
const tops = byTopLevel(parse(html));
const today = new Date().toISOString().slice(0, 10);

if (!DRY) mkdirSync(OUT, { recursive: true });
let pages = 0, links = 0;
const indexLines = ["# Bookmarks", "", `*Imported ${today}.*`, ""];
for (const [top, subMap] of [...tops].sort((a, b) => a[0].localeCompare(b[0]))) {
  const count = [...subMap.values()].reduce((n, x) => n + x.length, 0);
  links += count;
  pages++;
  const file = `${slugify(top)}.md`;
  if (!DRY) writeFileSync(join(OUT, file), pageFor(top, subMap, today), "utf8");
  indexLines.push(`- [[${slugify(top)}|Bookmarks — ${top}]] — ${count} links`);
  console.log(`  ${DRY ? "[dry] " : ""}${file.padEnd(28)} ${count} links`);
}
if (!DRY) writeFileSync(join(OUT, "_index.md"), indexLines.join("\n") + "\n", "utf8");
console.log(`${DRY ? "[dry-run] " : ""}${pages} pages, ${links} links → ${OUT}`);
