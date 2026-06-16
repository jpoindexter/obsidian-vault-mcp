# obsidian-vault-mcp

> A zero-dependency MCP server that turns any Obsidian vault into a self-improving AI knowledge base — read, search, self-ingest, and find semantic connections, all from your AI agent.

Built on [Andrej Karpathy's LLM wiki pattern](https://x.com/karpathy). No vector database. No external services. No paid plugins. Just markdown files and a local embedding model.

---

## What is this?

Most AI agents forget everything between sessions. This fixes that — but differently from simple memory systems.

Instead of dumping raw facts into a database, this follows the Karpathy wiki pattern: your agent maintains a **structured, self-referential wiki** of everything it learns. New knowledge gets compared to existing pages, cross-linked, and indexed. Contradictions get flagged. The wiki compounds over time like interest.

**Your agent can:**
- Read the wiki to answer questions from past context
- Self-ingest new knowledge directly — no human step required
- Find conceptually related pages using local semantic embeddings (no API calls)
- Update the rolling hot cache so the most recent context is always cheap to read
- Log every operation for auditability

**Use it with:** Claude Code, Vanta, Cursor, or any MCP-compatible agent.

---

## How it works

```
raw/              ← drop source docs here (articles, transcripts, notes)
wiki/
  concepts/       ← ideas, frameworks, mental models, techniques
  entities/       ← people, companies, tools, products
  sources/        ← one page per source doc (summary + takeaways + backlinks)
  analysis/       ← cross-source synthesis and comparisons
  index.md        ← master index — auto-maintained by the agent
  hot.md          ← rolling ~500-word cache of most recent context
  log.md          ← append-only operation history
CLAUDE.md         ← wiki agent instructions (ingest workflow, page format, etc.)
```

When the agent ingests a source:
1. Reads it and checks what already exists in the wiki
2. Creates 3–15 structured wiki pages with `[[wikilinks]]` cross-referencing existing content
3. Updates `wiki/index.md`
4. Appends to `wiki/log.md`
5. Overwrites `wiki/hot.md` with a summary of what was just added

The hot cache means your agent can read one ~500-word file to get recent context instead of crawling dozens of pages — dramatically reducing token usage on every query.

---

## Tools

| Tool | Type | Description |
|------|------|-------------|
| `vault_hot` | Read | Returns `wiki/hot.md` — the cheap first read for recent context |
| `vault_index` | Read | Returns `wiki/index.md` — the full page map grouped by type |
| `vault_read` | Read | Read any page by vault-relative path |
| `vault_search` | Read | Keyword search across `wiki/` via ripgrep |
| `vault_find_related` | Read | **Semantic similarity search** via local ollama embeddings — finds conceptual connections keyword search misses |
| `vault_list_raw` | Read | List files in `raw/` pending ingest |
| `vault_write_raw` | Write | Drop a Markdown note into `raw/` |
| `vault_write_wiki` | Write | Create or update any page inside `wiki/` |
| `vault_append_log` | Write | Append an entry to `wiki/log.md` (never overwrites) |
| `vault_update_hot` | Write | Overwrite `wiki/hot.md` with a session summary |

---

## Setup

### Prerequisites

- **Node 18+**
- **ripgrep** for keyword search: `brew install ripgrep` (macOS) or `apt install ripgrep`
- **ollama** for semantic search (optional — falls back to ripgrep automatically): [ollama.ai](https://ollama.ai)

### Install

```bash
git clone https://github.com/jpoindexter/obsidian-vault-mcp
cd obsidian-vault-mcp
```

No `npm install` needed — zero dependencies.

### Pull the embedding model (optional)

```bash
ollama pull nomic-embed-text
```

### Wire into your MCP client

**Claude Code** — add to `.mcp.json` in your project root or `~/.claude/mcp.json` globally:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": [
        "/absolute/path/to/obsidian-vault-mcp/mcp-server.mjs",
        "/absolute/path/to/your/vault"
      ]
    }
  }
}
```

**Cursor / Windsurf / other MCP clients** — same config format, wherever that client reads its MCP servers from.

**Vanta** — add to `~/.vanta/mcp.json`:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": [
        "/absolute/path/to/obsidian-vault-mcp/mcp-server.mjs",
        "/absolute/path/to/your/vault"
      ]
    }
  }
}
```

**Env var instead of CLI arg:**

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-vault-mcp/mcp-server.mjs"],
      "env": { "VAULT_PATH": "/absolute/path/to/your/vault" }
    }
  }
}
```

---

## Setting up your vault

The fastest way: open Claude Code in your vault folder and paste this prompt:

```
You are my LLM wiki agent. Set up this folder as a Karpathy-style personal knowledge base.
Create the structure: raw/, wiki/concepts/, wiki/entities/, wiki/sources/, wiki/analysis/,
wiki/index.md, wiki/hot.md, wiki/log.md, and CLAUDE.md explaining the ingest workflow and
page format. Follow the Karpathy LLM wiki pattern — index-first retrieval, wikilinks for
relationships, hot cache for cheap recent context.
```

Or create the folders manually and let the agent build the CLAUDE.md on first use.

---

## Importing existing chat history

Already have months of Claude Code or Codex conversations? `import-chats.mjs` mechanically extracts them into `raw/` as clean per-session markdown (tool-noise, hooks, and environment boilerplate stripped) — **no LLM, no cost, reversible.** Then let your agent self-ingest `raw/` → `wiki/` in batches.

```bash
node import-chats.mjs /path/to/your/vault --source both
node import-chats.mjs /path/to/your/vault --source claude --limit 50   # try a slice first
node import-chats.mjs /path/to/your/vault --source codex --dry-run     # preview counts only
```

Sources:
- `claude` — `~/.claude/projects/**/*.jsonl` (Claude Code transcripts)
- `codex` — `~/.codex/sessions` + `~/.codex/archived_sessions/rollout-*.jsonl`
- `both` — default

It writes one `<source>-<date>-<title>-<hash>.md` per session, skips sessions with no real conversational turns, and is idempotent (re-running overwrites the same files). This is the **stage** step — distillation into `wiki/` is a separate, controllable LLM pass (see below) so you decide how much token spend goes into building the wiki.

---

## Self-ingest workflow

Tell your agent to ingest something and it runs the full loop without you:

```
"Ingest this article into my wiki: [paste content]"
"Index my meeting notes from today into the vault"
"Add everything we just discussed to the knowledge base"
```

The agent:
1. Calls `vault_hot` + `vault_index` to understand what already exists
2. Calls `vault_write_wiki` × N to create structured pages with cross-links
3. Updates `wiki/index.md` via `vault_write_wiki`
4. Logs the operation with `vault_append_log`
5. Updates the hot cache with `vault_update_hot`

### Wiki page format

Every page follows this structure:

```markdown
---
tags: [tag1, tag2]
type: concept | entity | source | analysis
source: "[[Source Title]]"
created: YYYY-MM-DD
---

# Page Title

[content — specific, not generic]

## Related
- [[Link 1]]
- [[Link 2]]
```

---

## Semantic search

`vault_find_related` uses local ollama embeddings to find conceptually related pages — even when they share no keywords. This is the core feature Smart Connections charges for, built locally for free.

```
"What in my vault is related to this idea?"
"Find pages connected to [[Decision Making Under Uncertainty]]"
```

Results look like:
```
91.2%  wiki/concepts/mental-models.md
87.4%  wiki/analysis/decision-frameworks.md
82.1%  wiki/entities/daniel-kahneman.md
```

The embedding cache is in-memory per session — first call warms it up (a few seconds for large vaults), subsequent calls are instant.

**Override the model:**

```bash
VAULT_EMBED_MODEL=mxbai-embed-large node mcp-server.mjs /path/to/vault
```

**No ollama?** Falls back to ripgrep keyword search automatically. You lose semantic matching but everything else works.

---

## Token efficiency

One X user converted 383 files and 100+ meeting transcripts into a compact wiki and dropped token usage by 95% when querying with Claude. The pattern works because:

- The agent reads `hot.md` (500 words) instead of crawling all recent files
- It reads `index.md` to locate relevant pages instead of loading everything
- It follows `[[wikilinks]]` to load only the pages that matter
- It never loads raw source files — only the structured extractions

---

## Linting (keeping the wiki healthy)

Tell your agent `"lint the wiki"` and it will:
- Find orphaned pages (no incoming links)
- Find stubs (< 100 words)
- Flag contradictions between pages
- Suggest missing articles based on referenced-but-unlinked topics

It reports findings and waits for confirmation before changing anything.

---

## vs RAG / semantic search databases

| | obsidian-vault-mcp | Traditional RAG |
|---|---|---|
| **Retrieval** | Index + wikilinks + semantic | Embedding similarity |
| **Infrastructure** | Markdown files | Vector DB + embedding pipeline |
| **Cost** | Free (local ollama) | Ongoing compute + storage |
| **Maintenance** | Lint occasionally | Re-embed when content changes |
| **Relationships** | Explicit `[[wikilinks]]` | Implicit (chunk similarity) |
| **Scales to** | ~1000 pages comfortably | Millions of documents |
| **Human readable** | Yes — open in Obsidian | No |

For personal knowledge bases under ~1000 pages, the wiki pattern beats RAG on every dimension. For enterprise-scale corpora, use a proper vector database.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VAULT_PATH` | — | Path to your vault (alternative to CLI arg) |
| `VAULT_EMBED_MODEL` | `nomic-embed-text` | ollama model for embeddings |

---

## Requirements

- Node 18+
- ripgrep (`rg`)
- ollama + `nomic-embed-text` (optional, for `vault_find_related`)

---

## License

MIT
