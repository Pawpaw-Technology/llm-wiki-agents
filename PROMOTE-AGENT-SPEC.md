# `promote` Agent — Spec (v0.1)

**Goal**: turn a multi-turn human↔LLM conversation into one or more wiki pages that meet the project's quality bar.

**Slot in this repo**: a future fourth agent alongside `classify` / `ingest` / `lint`. Implementation TBD; this doc captures the three patterns worth building around.

---

## The 3 patterns this agent embodies

### 1. Conversation IS the draft

The conversation that triggered "write this up" is the draft engine — by the time a user asks for promotion, the material is usually already at higher quality than any cold-start writing the agent could do.

**Implication for the agent**:

- Input must include conversation history (turns since last topic shift), not just a goal string.
- The agent's primary job is **extract & format**, not author.
- Resist the impulse to re-research the topic — re-reading the chat is usually enough.

### 2. Verify at the promotion boundary

Chat tolerates "I think…" / from-memory claims. Wiki pages do not. Crossing the chat→doc boundary triggers a verification obligation: every API name, parameter, number, behavioral claim that originated from the model's memory must be re-checked against an authoritative source before it lands in the page.

**Implication for the agent**:

- Tool access is mandatory at this stage: `Context7` for libraries/SDKs, `Grep`/`Read` for project code, official docs for protocols.
- Claims that can't be verified must be **softened**, not deleted (e.g. "5–50μs" → "typically tens of μs, MCU-dependent").
- The ISR build session (2026-04-19) hit 8 factual errors with this pass alone — every one was from the model's prior turns, none caught by re-reading the chat.

### 3. 3x parallel orthogonal review

Three reviewers dispatched **in parallel** as subagents, each with a self-contained brief, word limit, and tool access:

| Lens                 | Catches                                                          | Tools needed        |
| -------------------- | ---------------------------------------------------------------- | ------------------- |
| **Beginner reader**  | undefined jargon, missing prerequisites, unclear reading order   | Read only           |
| **Technical writer** | redundancy across sibling pages, structure, length, scannability | Read + Glob         |
| **Fact-checker**     | every technical claim re-verified against authoritative source   | Context7 / WebFetch |

**Why three**: the lenses are orthogonal — none of them sees what the others see. Beginner can't spot factual errors; fact-checker can't see structural problems; writer is insensitive to API truth.

**Why parallel**: 3× faster than serial, no context cross-pollination, output is naturally structured for triage.

**Output contract**: each reviewer returns findings grouped by severity. Main agent triages → user picks scope (all / red-only / defer) → batch apply in a single commit whose message references finding IDs.

---

## Sketch of the agent shape (not yet built)

```
agents/
├── src/promote.ts        # orchestration: extract conversation → verify → write → review → triage → commit
├── prompts/
│   ├── promote.md            # extraction & first-draft prompt
│   ├── promote-review-beginner.md
│   ├── promote-review-writer.md
│   └── promote-review-factcheck.md
```

CLI shape, following the existing convention:

```bash
npm run promote -- --conversation <transcript-path> --target <wiki-page-path-or-dir>
npm run promote -- --conversation - --dry-run        # read transcript from stdin
```

---

## Status

**v0.1 — single case** (ISR series, 2026-04-19). Needs at least 2 more cases from different domains before any of this gets coded. Candidates:

- A research-heavy conversation about a paper → `architecture/` page
- An incident debrief conversation → `ops/` postmortem page

If a second case validates the same 3 patterns, this becomes the basis for `src/promote.ts`. If it doesn't, this doc gets revised before implementation.
