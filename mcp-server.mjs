#!/usr/bin/env node
// obsidian-vault-mcp — MCP server for a Karpathy-style LLM wiki vault.
// JSON-RPC 2.0 over stdio. Protocol 2024-11-05. Zero dependencies.
//
// Usage:
//   node mcp-server.mjs /path/to/vault
//   VAULT_PATH=/path/to/vault node mcp-server.mjs

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, appendFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, relative, dirname } from "node:path";

const VAULT_PATH = process.argv[2] ?? process.env.VAULT_PATH;
if (!VAULT_PATH) {
  process.stderr.write("obsidian-vault-mcp: vault path required.\n");
  process.stderr.write("Usage: node mcp-server.mjs /path/to/your/vault\n");
  process.stderr.write("   or: VAULT_PATH=/path/to/vault node mcp-server.mjs\n");
  process.exit(1);
}

const VAULT = resolve(VAULT_PATH);
const WIKI = join(VAULT, "wiki");
const RAW = join(VAULT, "raw");
const PROTOCOL_VERSION = "2024-11-05";

// In-memory embedding cache: abs-path -> { mtime, vec }
const EMBED_CACHE = new Map();
const EMBED_MODEL = process.env.VAULT_EMBED_MODEL ?? "nomic-embed-text";

function embed(text) {
  try {
    const body = JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 4000) });
    const raw = execSync(
      `curl -sf -X POST http://localhost:11434/api/embeddings -H 'Content-Type: application/json' -d ${JSON.stringify(body)}`,
      { encoding: "utf8", timeout: 15000 },
    );
    return JSON.parse(raw).embedding ?? null;
  } catch {
    return null;
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function walkMd(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) walkMd(p, acc);
    else if (f.name.endsWith(".md") && !["hot.md", "log.md"].includes(f.name)) acc.push(p);
  }
  return acc;
}

const TOOLS = [
  {
    name: "vault_hot",
    description: "Returns wiki/hot.md — ~500-word summary of the most recently ingested source. Read this first for recent context before querying the index.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault_index",
    description: "Returns wiki/index.md — master index of all pages grouped by type (Concepts, Entities, Sources, Analysis). Use this to locate specific pages before calling vault_read.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault_read",
    description: "Read a specific wiki page by its vault-relative path, e.g. 'wiki/concepts/foo.md'.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path, e.g. 'wiki/concepts/foo.md'" },
      },
      required: ["path"],
    },
  },
  {
    name: "vault_search",
    description: "Keyword search across wiki/ using ripgrep. Returns up to 8 matching files with surrounding context. Use vault_find_related for semantic/conceptual search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term or phrase" },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_find_related",
    description: "Semantic similarity search across wiki/ pages using local embeddings (ollama nomic-embed-text). Returns the top N pages most conceptually related to a query or an existing page — finds connections that keyword search misses. Falls back to ripgrep if ollama is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query. Leave blank if providing 'path'." },
        path: { type: "string", description: "Vault-relative path of an existing page to find related pages for." },
        top_n: { type: "number", description: "Results to return. Default 6." },
      },
    },
  },
  {
    name: "vault_list_raw",
    description: "List files in raw/ pending ingest. Returns filenames and sizes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault_write_raw",
    description: "Drop a Markdown note into raw/ for ingestion. Use for large source dumps. For quick knowledge capture, prefer self-ingest via vault_write_wiki.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename ending in .md, no path separators." },
        content: { type: "string", description: "Markdown content." },
        overwrite: { type: "boolean", description: "Overwrite if exists. Default false." },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "vault_write_wiki",
    description: "Create or overwrite a wiki page at a path inside wiki/ (e.g. 'wiki/concepts/foo.md', 'wiki/index.md'). Use during self-ingest to write structured pages.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path, must start with 'wiki/'." },
        content: { type: "string", description: "Full Markdown content." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "vault_append_log",
    description: "Append an entry to wiki/log.md (append-only operation history). Call once per ingest: date · source · pages created · one-line summary.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "string", description: "Log entry to append." },
      },
      required: ["entry"],
    },
  },
  {
    name: "vault_update_hot",
    description: "Overwrite wiki/hot.md with a ~500-word session summary. Call after any significant ingest or task. Sections: # Hot Cache / Last updated: YYYY-MM-DD / ## Source / ## What was learned / ## Cross-links / ## Open threads.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full replacement content for wiki/hot.md." },
      },
      required: ["content"],
    },
  },
];

function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toolResult(text, isError = false) { return { content: [{ type: "text", text: String(text) }], isError }; }

function callTool(name, args) {
  if (name === "vault_hot") {
    const p = join(WIKI, "hot.md");
    if (!existsSync(p)) return toolResult("hot.md not found — no ingests yet");
    return toolResult(readFileSync(p, "utf8"));
  }

  if (name === "vault_index") {
    const p = join(WIKI, "index.md");
    if (!existsSync(p)) return toolResult("index.md not found — wiki is empty");
    return toolResult(readFileSync(p, "utf8"));
  }

  if (name === "vault_read") {
    const rel = args.path;
    if (!rel) return toolResult("'path' is required", true);
    const abs = resolve(VAULT, rel);
    if (!abs.startsWith(VAULT + "/")) return toolResult("path must be inside the vault", true);
    if (!existsSync(abs)) return toolResult(`not found: ${rel}`, true);
    return toolResult(readFileSync(abs, "utf8"));
  }

  if (name === "vault_search") {
    const query = args.query;
    if (!query) return toolResult("'query' is required", true);
    let matchedFiles;
    try {
      const raw = execSync(`rg -i -l ${JSON.stringify(query)} ${JSON.stringify(WIKI)}`, {
        encoding: "utf8", maxBuffer: 512 * 1024,
      });
      matchedFiles = raw.trim().split("\n").filter(Boolean).slice(0, 8);
    } catch {
      return toolResult("no matches found");
    }
    if (!matchedFiles.length) return toolResult("no matches found");
    const results = matchedFiles.map((file) => {
      let ctx = "(context unavailable)";
      try {
        ctx = execSync(`rg -i -n -C 2 ${JSON.stringify(query)} ${JSON.stringify(file)}`, { encoding: "utf8" }).trim();
      } catch {}
      return `### ${relative(VAULT, file)}\n${ctx}`;
    });
    return toolResult(results.join("\n\n---\n\n"));
  }

  if (name === "vault_find_related") {
    const topN = Math.min(Number(args.top_n ?? 6), 20);
    let queryText = args.query ?? "";

    if (args.path) {
      const abs = resolve(VAULT, args.path);
      if (!abs.startsWith(VAULT + "/")) return toolResult("path must be inside the vault", true);
      if (!existsSync(abs)) return toolResult(`not found: ${args.path}`, true);
      queryText = readFileSync(abs, "utf8").slice(0, 4000);
    }

    if (!queryText.trim()) return toolResult("'query' or 'path' is required", true);

    const queryVec = embed(queryText);

    if (!queryVec) {
      const firstLine = queryText.split("\n").find((l) => l.trim()) ?? queryText;
      const words = firstLine.replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/\s+/).slice(0, 4).join("|");
      try {
        const raw = execSync(`rg -i -l ${JSON.stringify(words)} ${JSON.stringify(WIKI)}`, {
          encoding: "utf8", maxBuffer: 256 * 1024,
        });
        const files = raw.trim().split("\n").filter(Boolean).slice(0, topN);
        return toolResult(`(ollama unavailable — keyword fallback)\n${files.map((f) => relative(VAULT, f)).join("\n")}`);
      } catch {
        return toolResult("ollama unavailable and no keyword matches found");
      }
    }

    const pages = walkMd(WIKI);
    const scored = [];
    for (const abs of pages) {
      if (args.path && resolve(VAULT, args.path) === abs) continue;
      const mtime = statSync(abs).mtimeMs;
      let vec;
      const cached = EMBED_CACHE.get(abs);
      if (cached && cached.mtime === mtime) {
        vec = cached.vec;
      } else {
        const text = readFileSync(abs, "utf8").slice(0, 4000);
        vec = embed(text);
        if (vec) EMBED_CACHE.set(abs, { mtime, vec });
      }
      if (vec) scored.push({ rel: relative(VAULT, abs), score: cosine(queryVec, vec) });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topN);
    if (!top.length) return toolResult("no wiki pages found to compare");
    return toolResult(top.map((r) => `${(r.score * 100).toFixed(1)}%  ${r.rel}`).join("\n"));
  }

  if (name === "vault_list_raw") {
    mkdirSync(RAW, { recursive: true });
    const files = readdirSync(RAW).filter((f) => f.endsWith(".md"));
    if (!files.length) return toolResult("raw/ is empty — nothing pending ingest");
    const lines = files.map((f) => `${f} (${statSync(join(RAW, f)).size} bytes)`);
    return toolResult(lines.join("\n"));
  }

  if (name === "vault_write_raw") {
    const { filename, content, overwrite } = args;
    if (!filename || typeof filename !== "string") return toolResult("'filename' is required", true);
    if (!content || typeof content !== "string") return toolResult("'content' is required", true);
    if (!filename.endsWith(".md")) return toolResult("filename must end in .md", true);
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return toolResult("filename must not contain path separators or '..'", true);
    }
    mkdirSync(RAW, { recursive: true });
    const dest = join(RAW, filename);
    if (existsSync(dest) && !overwrite) {
      return toolResult(`file already exists: raw/${filename} — pass overwrite:true to replace`, true);
    }
    writeFileSync(dest, content, "utf8");
    return toolResult(`written: raw/${filename}`);
  }

  if (name === "vault_write_wiki") {
    const { path: rel, content } = args;
    if (!rel || typeof rel !== "string") return toolResult("'path' is required", true);
    if (!content || typeof content !== "string") return toolResult("'content' is required", true);
    if (!rel.startsWith("wiki/")) return toolResult("path must start with 'wiki/'", true);
    const abs = resolve(VAULT, rel);
    if (!abs.startsWith(WIKI)) return toolResult("path must be inside wiki/", true);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return toolResult(`written: ${rel}`);
  }

  if (name === "vault_append_log") {
    const { entry } = args;
    if (!entry || typeof entry !== "string") return toolResult("'entry' is required", true);
    mkdirSync(WIKI, { recursive: true });
    appendFileSync(join(WIKI, "log.md"), `\n${entry.trim()}\n`, "utf8");
    return toolResult("appended to wiki/log.md");
  }

  if (name === "vault_update_hot") {
    const { content } = args;
    if (!content || typeof content !== "string") return toolResult("'content' is required", true);
    mkdirSync(WIKI, { recursive: true });
    writeFileSync(join(WIKI, "hot.md"), content, "utf8");
    return toolResult("wiki/hot.md updated");
  }

  return toolResult(`unknown tool: ${name}`, true);
}

function handleMessage(msg) {
  const { id, method } = msg;
  if (id === undefined || id === null) return null;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "obsidian-vault-mcp", version: "1.0.0" },
      });
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const params = msg.params ?? {};
      if (!params.name) return rpcError(id, -32602, "tools/call requires 'name'");
      try {
        return ok(id, callTool(params.name, params.arguments ?? {}));
      } catch (err) {
        return rpcError(id, -32603, String(err?.message ?? err));
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method ?? "(none)"}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const res = handleMessage(msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));
