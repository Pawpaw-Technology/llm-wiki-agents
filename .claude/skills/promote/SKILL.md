---
name: promote-to-wiki
description: Promote a multi-turn conversation into one or more wiki pages with verified facts, proper structure, and multi-perspective review. Use whenever the user signals that the current discussion should become durable knowledge — phrases like "写成 wiki", "归档", "建一页", "把这个做成一页", "write this up", "capture as a page", "save to the wiki", "sink this into the knowledge base". Also trigger when a conversation has spent 4+ deep turns on a single concept and the user shows interest in making it permanent. Do not undertrigger — promotion is the moment ephemeral chat crystallizes into shareable knowledge, and skipping the rigor below means bad pages land. The skill embodies three patterns proven on the ISR series build (concepts/isr.md + concepts/top-half-bottom-half.md + tools/zephyr-isr-api-cheatsheet.md, 2026-04-19): (1) treat the existing conversation as the draft, (2) verify every from-memory claim at the chat→doc boundary, (3) dispatch 3 parallel orthogonal reviewers.
---

# promote-to-wiki

Convert the in-session conversation into wiki page(s) that meet the project's quality bar.

This skill embodies three patterns proven on a single case study (the ISR series). It is **v0.1** — expect adjustments after the next real promotion event.

## Companion spec

The full reasoning is in `agents/PROMOTE-AGENT-SPEC.md` at the repo root. This SKILL.md is the in-session executable counterpart; the spec is the document you'd hand someone to explain why.

---

## The three patterns

### 1. Conversation IS the draft

By the time the user says "write this up," the multi-turn conversation already contains material at higher quality than any cold-start writing you could produce. Re-eliciting wastes time and degrades quality.

**What this means for you**:
- Re-read the conversation since the topic was introduced. Pay attention to: how the user pushed back, what metaphors landed, what the user added vs. what you added, what was clarified after confusion.
- Your job is **extract & format**, not author. Treat the conversation as the source-of-truth for content; the wiki is the destination format.
- Resist re-researching the topic from scratch — that's a sign you're falling back on cold-start authoring.

### 2. Verify at the promotion boundary

Chat tolerates "I think..." / from-memory claims. Wiki pages do not. The chat→doc transition triggers a verification obligation: every API name, parameter, number, and behavioral claim that originated from your memory must be re-checked against an authoritative source before it lands.

**What this means for you**:
- Use Context7 MCP for any library / SDK / framework claim. (`mcp__claude_ai_Context7__resolve-library-id` then `query-docs`.)
- Use Grep + Read for project-internal facts (file paths, function signatures, conventions).
- Use WebFetch for protocol / standard claims.
- Claims you can't verify must be **softened**, not deleted (e.g. "5–50μs" → "typically tens of μs, MCU-dependent"). Confident wrong is worse than honestly hedged.
- The ISR build hit 8 factual errors with this pass alone — every one was from prior turns, none caught by re-reading the chat.

### 3. 3x parallel orthogonal review

Three reviewers dispatched **in parallel** as subagents, each with a self-contained brief. The lenses are orthogonal — none sees what the others see.

| Lens | Catches | Tools |
| --- | --- | --- |
| **Beginner reader** | undefined jargon, missing prerequisites, unclear reading order | Read |
| **Technical writer** | redundancy, structure, length, scannability, voice deviation | Read + Glob |
| **Fact-checker** | every technical claim re-verified against authoritative source | Context7, WebFetch, Grep |

**Briefs are in `references/`** of this skill — parameterize them with the actual page paths you wrote, then dispatch via the Agent tool with `subagent_type: general-purpose`.

Why parallel: 3× faster than serial, no context cross-pollination, output naturally structured for triage.

---

## Workflow

Follow this in order. Skipping steps is the most common failure mode.

### Step 1 — Promotion contract (confirm with user)

Before doing anything else, get explicit confirmation on three things:

1. **考证标准**: Do they want fact-verification (default: yes for any API/library/protocol claim)?
2. **目标位置**: Which wiki, which page type (concept / source summary / tweet digest), which subdirectory?
3. **范围**: Is this one page or do they expect splits?

A short message: "Before I write — verify against Context7 for [library X], target as `concepts/foo.md`, OK to split if it gets long?"

This is the chat→doc mode switch. Don't skip it.

### Step 2 — Load the house style

Required reads before writing:

1. The wiki's `CLAUDE.md` (page-type spec, frontmatter schema, decay defaults)
2. The wiki's `index.md` (existing landscape, what's already covered)
3. Tail of `log.md` (recent activity)
4. **At least one** sibling page of the same type (concept→concept, tool→tool) — for voice/length/structure calibration

**Red line**: do not write a wiki page without reading at least one sibling first. House style precedes content.

### Step 3 — Verify facts from the conversation

Walk through the conversation and extract every factual claim. For each:

- Library/SDK/framework call → Context7
- Project-specific fact → Grep / Read
- Protocol / standard → WebFetch official docs
- Number you stated as "approximately X" → either find a source or soften wording

Keep a running mental list of things that need softening. You'll apply them during the draft.

### Step 4 — First draft + boundary check

Write the page following the house style. Then **before showing the user**, evaluate:

- Length > ~120 lines? → consider splitting.
- Contains "what is it" + "how to use" + "reference table"? → almost certainly split.

**Splitting rules**:

| Page type | Owns | Doesn't own |
| --- | --- | --- |
| Concept | definition, boundary, minimal example, principles | full API tables, debug recipes |
| Pattern | standard implementation, variants, exemplar | concept definition (link out) |
| Reference / Cheatsheet | API tables, glossary, operational steps | concept exposition (link out) |

Each page should have a single clear identity. Cross-link don't duplicate.

Add **`> 前置阅读`** callouts to signal reading order between sibling pages — prerequisites are not optional metadata, they're load-bearing for first-time readers.

### Step 5 — 3x parallel review

Dispatch three subagents in **a single message with three Agent tool calls**, using the brief templates in `references/`:

- `references/review-beginner.md` — fill in the page paths
- `references/review-writer.md` — fill in the page paths + sibling pages for calibration
- `references/review-factcheck.md` — fill in the page paths + the library/source to check against

Each brief is self-contained (the subagent doesn't see this conversation), specifies word limit, and demands grouped/severity-tagged findings.

### Step 6 — Triage and apply

When all three return:

1. Group findings by severity: **factual error > structural > accessibility**.
2. Show the user the consolidated list grouped by severity.
3. Let the user pick scope (apply all / red-only / defer).
4. Apply in a single commit; commit message references finding IDs for traceability.

### Step 7 — Hygiene

- Update wiki `index.md` (correct category, one-line summary)
- Append entry to wiki `log.md` (`[date] action | summary`)
- Add reverse `related:` references on any wiki page now linking back to your new pages
- Unrelated cleanup found along the way → **separate PR**, not bundled

---

## Output: where files go

The wiki is at `$WIKI_ROOT` (or `../wiki` relative to this agents repo). Pages go under:

```
wiki/
├── concepts/      # cross-source synthesis, decay: slow
├── ops/           # ADRs, postmortems, decisions
├── architecture/
├── tools/         # workflows, cheatsheets, methodologies
├── training/
├── infra/
└── product/
```

Update `wiki/index.md` and `wiki/log.md` after every page creation.

---

## When NOT to use this skill

- The conversation hasn't actually developed material — user is asking a one-off question. No promotion is needed; just answer.
- The user wants a quick scratch note, not a wiki page. Use a plain markdown file or memory entry.
- The content is ephemeral session state (current task, debug context) — that belongs in plan/task tracking, not the wiki.
- The user said something like "remember this" without specifying a target — that's likely a memory write, not a wiki promotion.

---

## Anti-patterns observed in v0.1

- **Bloating the first draft**: don't try to capture every nuance in one page. The split happens in Step 4 for a reason.
- **Skipping Step 1 confirmation**: leaping straight into writing wastes effort if the user wanted a different format/location.
- **Sequential review instead of parallel**: 3× slower and creates context cross-pollination between reviewers.
- **Treating folklore numbers as facts**: "5–50μs", "几十毫秒" — if you can't cite it, soften it.
- **Concept-page proliferation**: when a follow-up question arises, default to extending an existing page; new page only when truly orthogonal. Max 3–4 pages per concept cluster.

---

## References

- `references/review-beginner.md` — beginner-reader review brief template
- `references/review-writer.md` — technical-writer review brief template
- `references/review-factcheck.md` — fact-check review brief template
- `../../../PROMOTE-AGENT-SPEC.md` — full methodology spec (in agents repo root)
