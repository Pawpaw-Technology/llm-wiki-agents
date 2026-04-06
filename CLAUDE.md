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

## Structure

```
src/
├── classify.ts    # Classification agent — sorts _uncategorized pages
├── librarian.ts   # Q&A librarian agent (planned)
└── lint.ts        # Freshness triage agent (planned)
prompts/
└── classify.md    # Prompt template for classification
```

## Dependencies

- **Runtime**: `lw` CLI installed at `/opt/homebrew/bin/lw` (or on PATH)
- **LLM dispatch**: `codebridge` (linked as `file:../tool/codebridge` — monorepo layout)
- **Node**: 22+, TypeScript via `tsx`

## Build & Run

```bash
npm install                                    # install deps (needs monorepo layout for codebridge)
npm run classify                               # classify with claude-code
npm run classify -- --engine kimi-code         # use kimi
npm run classify -- --batch 10 --dry-run       # preview 10 pages
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
- CLI args: `--engine`, `--model`, `--batch`, `--dry-run`
- Errors and progress to stderr, structured output to stdout
- Prompt templates in `prompts/` with `{{placeholder}}` syntax
- Agent-friendly: `--dry-run` for preview, JSON stdout for piping
