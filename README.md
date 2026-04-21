# LLM Wiki Agents

LLM orchestration layer — classification, librarian, lint agents.

Calls tool layer via CLI (`lw`) or MCP (`lw serve`).
Uses `../codebridge/` for multi-engine LLM dispatch.

## Prerequisites

The `lw` CLI must be installed and on `PATH`:

```bash
curl -fsSL https://github.com/Pawpaw-Technology/llm-wiki/releases/latest/download/install.sh | sh
```

This package is the **batch / cron orchestration layer** that calls `lw` for bulk operations (daily ingest, weekly lint, etc.). End users typically interact with `lw` via their agent tool (Claude Code / Codex / OpenClaw) and the `llm-wiki:import` skill — this layer is for scheduled jobs and team-scope automation, not first-time use.

## Structure

```
agents/
├── classify/      ← Classification agent
├── librarian/     ← Q&A librarian agent
├── lint/          ← Freshness triage agent
└── common/        ← Shared prompts, taxonomy, utils
```
