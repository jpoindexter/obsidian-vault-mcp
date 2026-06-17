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

# Optional model override (e.g. MODEL=gpt-5 ./distill-loop.sh ...) for when the
# default is at capacity. Empty = codex default.
MODEL_ARG=()
[ -n "${MODEL:-}" ] && MODEL_ARG=(-m "$MODEL")

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
   under ~200 lines; PRESERVE the existing '## Bookmarks' section and its links — never
   remove it), append ONE line to wiki/log.md (date · files processed · pages
   created/updated · one-line summary), and rewrite wiki/hot.md (~500 words: what was
   just learned + the most active threads).
4. Stop. Do not start another batch — I re-invoke you in a loop.

Be ruthless about noise: a page must earn its place. No page for status updates,
greetings, or tool spam. Quality over coverage."

fails=0
MAX_FAILS="${MAX_FAILS:-20}"   # give up only after this many CONSECUTIVE failures
WAIT="${WAIT:-90}"             # seconds to wait between retries (capacity errors are transient)

while :; do
  remaining=$(find "$VAULT/raw" -maxdepth 1 -name '*.md' -type f | wc -l | tr -d ' ')
  echo "── remaining raw files: $remaining ──"
  [ "$remaining" -eq 0 ] && { echo "✓ done — raw/ fully distilled"; break; }

  if codex exec -C "$VAULT" "${SANDBOX[@]}" "${MODEL_ARG[@]}" --skip-git-repo-check "$PROMPT"; then
    fails=0
  else
    fails=$((fails + 1))
    echo "⚠ codex exec failed (consecutive: $fails/$MAX_FAILS) — likely model-at-capacity."
    if [ "$fails" -ge "$MAX_FAILS" ]; then
      echo "✗ $MAX_FAILS failures in a row — stopping (progress saved in raw/_processed/; just re-run to resume)."
      break
    fi
    echo "  waiting ${WAIT}s then retrying (set MODEL=<other> to switch model)…"
    sleep "$WAIT"
  fi
done
