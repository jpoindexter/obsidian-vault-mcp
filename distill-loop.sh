#!/usr/bin/env bash
# distill-loop.sh — grind a vault's raw/ into structured wiki/ pages using Codex.
#
# The companion to import-chats.mjs: that STAGES chat history into raw/ (mechanical,
# no LLM); this DISTILLS raw/ → wiki/ (the LLM pass) in resumable batches. Progress
# lives on disk — processed files move to raw/_processed/ — so each iteration starts
# with fresh context (flat per-batch cost) and you can Ctrl-C / re-run anytime.
#
# Usage:
#   ./distill-loop.sh /path/to/your/vault [BATCH]
#
# Requires the Codex CLI (`codex`). Defaults to the sandboxed workspace-write policy;
# set FULL_AUTO=1 to bypass approvals entirely (removes the sandbox — only once trusted).
set -euo pipefail

VAULT="${1:-}"
BATCH="${2:-15}"   # files per iteration — lower = cheaper/safer, higher = fewer model calls
[ -n "$VAULT" ] || { echo "usage: ./distill-loop.sh /path/to/vault [BATCH]"; exit 1; }
[ -d "$VAULT/raw" ] || { echo "no raw/ in $VAULT — run import-chats.mjs first"; exit 1; }
command -v codex >/dev/null || { echo "codex CLI not found on PATH"; exit 1; }

mkdir -p "$VAULT/raw/_processed" "$VAULT/wiki/concepts" "$VAULT/wiki/entities" \
         "$VAULT/wiki/sources" "$VAULT/wiki/analysis"

if [ "${FULL_AUTO:-0}" = "1" ]; then
  SANDBOX=(--dangerously-bypass-approvals-and-sandbox)
else
  SANDBOX=(-s workspace-write)
fi

PROMPT="You are my LLM-wiki librarian. The vault has raw/ (staged chat sessions) and wiki/
(the structured knowledge base: concepts/ entities/ sources/ analysis/ + index.md,
hot.md, log.md). Karpathy LLM-wiki pattern: index-first, [[wikilinks]] for relations,
hot.md = cheap recent-context cache.

Do EXACTLY ONE batch, then stop:

1. Read wiki/index.md to learn what already exists (so you cross-link, not duplicate).
2. Take the first ${BATCH} *.md files in raw/ (top level only, NOT raw/_processed/),
   oldest filename order. For each file:
   - If it holds reusable knowledge (a decision, a pattern, how something works, facts
     about a person/tool/project, a solved problem): create or UPDATE wiki pages —
     wiki/concepts|entities|sources|analysis/<slug>.md — with frontmatter
     (tags, type, source, created) and [[wikilinks]] to related pages. Prefer updating
     an existing page over making a near-duplicate.
   - If it's junk (pure tool output, trivial one-off, abandoned, no reusable signal):
     make NO page. Just move it on.
   - Move the raw file to raw/_processed/ when done (processed = moved, always).
3. After the batch: update wiki/index.md (add new pages under the right section, keep it
   under ~200 lines), append ONE line to wiki/log.md (date · files processed · pages
   created/updated · one-line summary), and rewrite wiki/hot.md (~500 words: what was
   just learned + the most active threads).
4. Stop. Do not start another batch — I re-invoke you in a loop.

Be ruthless about noise: a page must earn its place. No page for status updates,
greetings, or tool spam. Quality over coverage."

while :; do
  remaining=$(find "$VAULT/raw" -maxdepth 1 -name '*.md' -type f | wc -l | tr -d ' ')
  echo "── remaining raw files: $remaining ──"
  [ "$remaining" -eq 0 ] && { echo "✓ done — raw/ fully distilled"; break; }

  codex exec -C "$VAULT" "${SANDBOX[@]}" --skip-git-repo-check "$PROMPT" \
    || { echo "✗ codex exec failed — stopping (progress saved in raw/_processed/)"; break; }
done
