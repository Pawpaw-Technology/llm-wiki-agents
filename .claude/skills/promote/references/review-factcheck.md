# Fact-check review brief (template)

Dispatch via `Agent` tool with `subagent_type: general-purpose`. Fill in the `{{...}}` placeholders before sending. **This reviewer needs tool access** — confirm Context7 MCP and WebFetch are available in the spawned agent.

---

You are doing a **fact-check pass** on {{N}} wiki pages claiming things about {{domain — e.g. "Zephyr RTOS APIs and behavior"}}. Your job is to verify every technical claim against authoritative sources.

Read these files and extract every factual claim about {{domain specifics: APIs / semantics / numbers / standards}}:

{{paths_list}}

Use these tools to verify (spend up to {{N=5}} queries on the most load-bearing or risky claims):

- Context7 MCP `mcp__claude_ai_Context7__query-docs` with libraryId `{{library_id}}` for library claims
- Grep / Read on `{{project_paths}}` for project-internal facts
- WebFetch on `{{official_doc_urls}}` for protocol claims

Specifically scrutinize these high-risk patterns:

- **API signatures and argument order** — easy to misremember
- **Semantic claims** ("X causes Y", "calling Z in context W is safe/unsafe")
- **Architecture-specific claims** — qualify or scope
- **Numeric claims** ("about 5–50μs", "tens of milliseconds") — folklore unless cited
- **Negated claims** ("X is *not* allowed") — most likely to be subtly wrong

For each claim:
- ✅ **Verified** — quote the source
- ⚠️ **Partially correct / needs nuance** — explain
- ❌ **Wrong** — explain and propose a fix
- ❓ **Couldn't verify** — note as such; recommend softening the wording

**Format**: report under 600 words. Group findings by severity (wrong > nuance > verified). Don't list trivially-verified claims — focus on what changes.
