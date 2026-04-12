# CLAUDE.md

## What This Is

LLM Wiki Agents (`@llm-wiki/agents`) — TypeScript orchestration layer that classifies, curates, and lints wiki pages using LLM engines.

**Repo:** https://github.com/Pawpaw-Technology/llm-wiki-agents

## Architecture

```
3-layer stack:
  Tool (lw CLI, Rust)  →  Agents (this repo, TypeScript)  →  Orchestration (shell+cron)
```

Agents call the `lw` CLI for wiki operations and use `codebridge` for multi-engine LLM dispatch. No API keys in this layer — LLM access is via codebridge subprocess engines (claude-code, kimi-code, codex, opencode).

Three active agents share `src/shared.ts` for wiki I/O, engine creation, prompt loading, JSON parsing, and index/log updates. Each agent owns its own CLI arg extension and validation logic.

## Structure

```
src/
├── shared.ts      # Common utilities — BaseArgs, wiki I/O, engine factory,
│                  #   parseJsonResponse, loadPrompt, dispatchTask,
│                  #   appendToIndex, appendToLog, CATEGORIES
├── classify.ts    # Classification agent — sorts _uncategorized pages
├── ingest.ts      # Batch ingest agent — raw/ sources → wiki pages
└── lint.ts        # Lint agent — report/fix/apply modes (auto-fix + LLM proposals)
prompts/
├── classify.md    # Prompt template for classification
├── ingest.md      # Prompt template for raw-source ingestion
└── lint-fix.md    # Prompt template for lint fixes (concept + rewrite modes)
```

## Dependencies

- **Runtime**: `lw` CLI installed at `/opt/homebrew/bin/lw` (or on PATH)
- **LLM dispatch**: `codebridge` (linked as `file:../tool/codebridge` — monorepo layout)
- **Node**: 22+, TypeScript via `tsx`

## Build & Run

```bash
npm install                                    # install deps (needs monorepo layout for codebridge)
npm run classify                               # classify _uncategorized pages
npm run classify -- --engine kimi-code         # use kimi engine
npm run classify -- --batch 10 --dry-run       # preview 10 pages
npm run ingest                                 # auto-scan raw/, ingest unprocessed sources
npm run ingest -- --source "raw/tweets/foo.md" # ingest explicit source file
npm run ingest -- --batch 5 --dry-run          # preview 5 sources
npm run lint                                   # report only (no changes)
npm run lint -- --fix                          # auto-fix + generate LLM proposals
npm run lint -- --fix --apply                  # auto-fix + apply LLM proposals, then re-lint
npm run lint -- --fix --category ops           # scope fixes to one category
```

## Environment

- `LW_WIKI_ROOT` or `WIKI_ROOT` — path to wiki data repo (default: `../../wiki` relative to src)
- All output goes to stderr; machine-readable JSON to stdout

## Development Workflow

This repo is a submodule of `llm-wiki-mono`. For local dev:

```bash
cd /Users/vergil/Devwork/homebrew/llm-wiki-mono/agents
npm install
npm run classify -- --dry-run
```

## Project Conventions

- TypeScript strict mode, ESNext modules
- All agents import wiki I/O and engine helpers from `src/shared.ts` — never duplicate
- CLI args parsed via `parseBaseArgs()`: `--engine`, `--model`, `--batch`, `--dry-run`
- Agent-specific args extend `BaseArgs` (e.g. ingest adds `--source`, lint adds `--fix`/`--apply`/`--category`)
- Errors and progress to stderr, structured JSON output to stdout
- Prompt templates in `prompts/` with `{{placeholder}}` syntax, loaded via `loadPrompt()`
- LLM responses parsed with `parseJsonResponse<T>()` (handles code blocks, raw newlines, bracket extraction)
- `--dry-run` previews prompt + target list without LLM calls
- Engine created once in `main()`, passed to functions that need LLM dispatch
- Same-session retry via `engine.send()` on JSON parse failure (ingest agent)
