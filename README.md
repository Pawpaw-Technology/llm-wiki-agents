# LLM Wiki Agents

LLM orchestration layer — classification, librarian, lint agents.

Calls tool layer via CLI (`lw`) or MCP (`lw serve`).
Uses `../codebridge/` for multi-engine LLM dispatch.

## Structure

```
agents/
├── classify/      ← Classification agent
├── librarian/     ← Q&A librarian agent
├── lint/          ← Freshness triage agent
└── common/        ← Shared prompts, taxonomy, utils
```
