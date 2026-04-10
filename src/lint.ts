#!/usr/bin/env tsx
/**
 * Wiki Lint Agent
 *
 * Runs wiki health checks via `lw lint`, then fixes issues.
 * Simple fixes are automatic; complex fixes (requiring LLM content generation)
 * produce proposals that need `--apply` to execute.
 *
 * Three modes:
 *   Report (default): run `lw lint --format json`, output findings, exit
 *   Fix (--fix):      auto-fix simple issues + generate LLM proposals
 *   Apply (--fix --apply): auto-fix + execute LLM proposals, then re-lint
 *
 * Usage:
 *   npm run lint                              # report only
 *   npm run lint -- --fix                     # auto-fix + proposals
 *   npm run lint -- --fix --apply             # auto-fix + apply proposals
 *   npm run lint -- --fix --category ops      # scope to one category
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  WIKI_ROOT,
  lw,
  createEngine,
  parseBaseArgs,
  parseJsonResponse,
  loadPrompt,
  dispatchTask,
} from "./shared.js";
import type { BaseArgs } from "./shared.js";

// ---------------------------------------------------------------------------
// CLI args (extends BaseArgs)
// ---------------------------------------------------------------------------

interface LintArgs extends BaseArgs {
  fix: boolean;
  apply: boolean;
  category: string;
}

function parseLintArgs(): LintArgs {
  const base = parseBaseArgs({ batch: 20 });
  const argv = process.argv.slice(2);
  let fix = false;
  let apply = false;
  let category = "";

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--fix":
        fix = true;
        break;
      case "--apply":
        apply = true;
        break;
      case "--category":
      case "-c":
        category = argv[++i];
        break;
    }
  }

  // --apply implies --fix
  if (apply) fix = true;

  return { ...base, fix, apply, category };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FreshnessReport {
  fresh: number;
  suspect: number;
  stale: number;
  stale_pages: string[];
}

interface LintReport {
  todo_pages: string[];
  broken_related: { page: string; broken_link: string }[];
  orphan_pages: string[];
  missing_concepts: { slug: string; references: string[] }[];
  freshness: FreshnessReport;
}

interface ConceptProposal {
  type: "create_concept";
  slug: string;
  content: string;
  index_entry: string;
  related_updates: { path: string; add_related: string }[];
}

interface RewriteProposal {
  type: "rewrite_page";
  path: string;
  content: string;
  index_entry: string;
}

interface StaleWarning {
  type: "stale_warning";
  paths: string[];
}

type Proposal = ConceptProposal | RewriteProposal | StaleWarning;

// ---------------------------------------------------------------------------
// Wiki I/O helpers
// ---------------------------------------------------------------------------

const WIKI_DIR = path.join(WIKI_ROOT, "wiki");

function readWikiFile(relPath: string): string {
  const absPath = path.join(WIKI_DIR, relPath);
  return readFileSync(absPath, "utf-8");
}

function writeWikiFile(relPath: string, content: string): void {
  const absPath = path.join(WIKI_DIR, relPath);
  writeFileSync(absPath, content, "utf-8");
}

function wikiFileExists(relPath: string): boolean {
  return existsSync(path.join(WIKI_DIR, relPath));
}

function readConventions(): string {
  const claudeMdPath = path.join(WIKI_ROOT, "CLAUDE.md");
  return readFileSync(claudeMdPath, "utf-8");
}

// ---------------------------------------------------------------------------
// lw lint wrapper
// ---------------------------------------------------------------------------

function runLint(category: string): LintReport {
  const categoryArg = category ? ` --category ${category}` : "";
  const raw = lw(`lint --format json${categoryArg}`);
  return JSON.parse(raw) as LintReport;
}

// ---------------------------------------------------------------------------
// Auto-fix: broken_related
// ---------------------------------------------------------------------------

function findClosestMatch(brokenLink: string): string | null {
  // Extract the category and filename parts
  const parts = brokenLink.split("/");
  if (parts.length < 2) return null;

  const category = parts[0];
  const categoryDir = path.join(WIKI_DIR, category);

  if (!existsSync(categoryDir)) return null;

  let files: string[];
  try {
    files = readdirSync(categoryDir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }

  const brokenSlug = path.basename(brokenLink, ".md").toLowerCase();

  // Try to find a file whose slug shares significant overlap
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const file of files) {
    const fileSlug = path.basename(file, ".md").toLowerCase();
    const score = computeSimilarity(brokenSlug, fileSlug);
    if (score > bestScore && score > 0.5) {
      bestScore = score;
      bestMatch = `${category}/${file}`;
    }
  }

  return bestMatch;
}

/** Simple bigram similarity (Dice coefficient) */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));

  let intersection = 0;
  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.slice(i, i + 2);
    bigramsB.add(bigram);
    if (bigramsA.has(bigram)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

function fixBrokenRelated(findings: LintReport["broken_related"]): number {
  let fixed = 0;

  for (const { page, broken_link } of findings) {
    const absPath = path.join(WIKI_DIR, page);
    if (!existsSync(absPath)) {
      console.error(`   skipped ${page} — file not found`);
      continue;
    }

    let content = readFileSync(absPath, "utf-8");
    const match = findClosestMatch(broken_link);

    if (match) {
      // Replace the broken link with the closest match
      content = content.replaceAll(broken_link, match);
      console.error(`   fixed ${page}: ${broken_link} -> ${match}`);
    } else {
      // Remove the broken related entry from frontmatter
      const lines = content.split("\n");
      const filtered = lines.filter((line) => !line.includes(broken_link));
      content = filtered.join("\n");
      console.error(`   removed ${page}: ${broken_link} (no match found)`);
    }

    writeFileSync(absPath, content, "utf-8");
    fixed++;
  }

  return fixed;
}

// ---------------------------------------------------------------------------
// Auto-fix: orphan_pages
// ---------------------------------------------------------------------------

function fixOrphanPages(orphans: string[]): number {
  if (orphans.length === 0) return 0;

  const indexPath = path.join(WIKI_DIR, "index.md");
  let indexContent = readFileSync(indexPath, "utf-8");
  let fixed = 0;

  // Category heading map (matches the wiki index.md headings)
  const categoryHeadings: Record<string, string> = {
    ops: "## Ops",
    architecture: "## Architecture",
    training: "## Training",
    infra: "## Infra",
    tools: "## Tools",
    product: "## Product",
    concepts: "## Concepts",
  };

  for (const orphan of orphans) {
    // Extract category from path (e.g., "ops/foo.md" -> "ops")
    const category = orphan.split("/")[0];
    const heading = categoryHeadings[category];

    if (!heading) {
      console.error(
        `   skipped orphan ${orphan} — unknown category "${category}"`,
      );
      continue;
    }

    // Read the page to get its title for the index entry
    let title = path.basename(orphan, ".md");
    try {
      const pageContent = readWikiFile(orphan);
      const titleMatch = pageContent.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      if (titleMatch) title = titleMatch[1].trim();
    } catch {
      // Use filename as title fallback
    }

    const entry = `- [${title}](${orphan}) — (auto-added by lint)`;

    // Find the heading in index.md and append after the last entry in that section
    const headingIdx = indexContent.indexOf(heading);
    if (headingIdx === -1) {
      // Heading doesn't exist yet — append it at the end
      indexContent += `\n\n${heading}\n\n${entry}\n`;
    } else {
      // Find the next heading (## ) or end of file
      const afterHeading = indexContent.indexOf("\n", headingIdx);
      const nextHeading = indexContent.indexOf("\n## ", afterHeading + 1);
      const insertPos = nextHeading === -1 ? indexContent.length : nextHeading;

      // Insert the entry before the next heading
      const before = indexContent.slice(0, insertPos).trimEnd();
      const after = indexContent.slice(insertPos);
      indexContent = before + "\n" + entry + "\n" + after;
    }

    console.error(`   added orphan to index: ${orphan}`);
    fixed++;
  }

  writeFileSync(indexPath, indexContent, "utf-8");
  return fixed;
}

// ---------------------------------------------------------------------------
// LLM proposal: missing_concepts
// ---------------------------------------------------------------------------

async function proposeMissingConcepts(
  concepts: LintReport["missing_concepts"],
  args: LintArgs,
): Promise<ConceptProposal[]> {
  const proposals: ConceptProposal[] = [];
  const conventions = readConventions();
  const engine = createEngine(args.engine);

  // Only process concepts with 3+ references (spec requirement)
  const eligible = concepts.filter((c) => c.references.length >= 3);

  for (const concept of eligible) {
    console.error(
      `   generating concept: ${concept.slug} (${concept.references.length} refs)`,
    );

    // Read referencing pages, truncated to 300 chars each
    const referencingPages = concept.references
      .map((ref) => {
        try {
          const content = readWikiFile(ref);
          return `### ${ref}\n${content.slice(0, 300)}`;
        } catch {
          return `### ${ref}\n(could not read)`;
        }
      })
      .join("\n\n");

    const prompt = loadPrompt("lint-fix", {
      mode: "concept",
      conventions,
      concept_slug: concept.slug,
      referencing_pages: referencingPages,
      // Mode B placeholders — empty when in concept mode
      current_page: "",
      raw_source: "",
    });

    if (args.dryRun) {
      console.error(
        `   [dry-run] would dispatch concept prompt (${prompt.length} chars)`,
      );
      continue;
    }

    try {
      const response = await dispatchTask(engine, {
        taskId: `lint-concept-${concept.slug}-${Date.now()}`,
        prompt,
        wikiRoot: WIKI_ROOT,
        engineName: args.engine,
        model: args.model || undefined,
      });

      if (response.error) {
        console.error(
          `   error for ${concept.slug}: ${response.error.message}`,
        );
        continue;
      }

      const parsed = parseJsonResponse<{
        slug: string;
        wiki_page_markdown: string;
        index_entry: string;
        related_updates: { path: string; add_related: string }[];
      }>(response.output);

      proposals.push({
        type: "create_concept",
        slug: parsed.slug || concept.slug,
        content: parsed.wiki_page_markdown,
        index_entry: parsed.index_entry,
        related_updates: parsed.related_updates || [],
      });

      console.error(`   proposal ready: ${concept.slug}`);
    } catch (e) {
      console.error(`   failed for ${concept.slug}: ${(e as Error).message}`);
    }
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// LLM proposal: todo_pages
// ---------------------------------------------------------------------------

async function proposeTodoRewrites(
  todoPages: string[],
  args: LintArgs,
): Promise<RewriteProposal[]> {
  const proposals: RewriteProposal[] = [];
  const conventions = readConventions();
  const engine = createEngine(args.engine);

  for (const pagePath of todoPages) {
    console.error(`   generating rewrite: ${pagePath}`);

    let currentPage: string;
    try {
      currentPage = readWikiFile(pagePath);
    } catch {
      console.error(`   skipped ${pagePath} — could not read`);
      continue;
    }

    // Extract raw source path from frontmatter sources: field
    let rawSource = "";
    const sourcesMatch = currentPage.match(
      /^sources:\s*\n((?:\s+-\s+.+\n?)*)/m,
    );
    if (sourcesMatch) {
      const sourceLines = sourcesMatch[1].trim().split("\n");
      for (const line of sourceLines) {
        const srcPath = line.replace(/^\s*-\s*/, "").trim();
        if (srcPath) {
          const absSourcePath = path.join(WIKI_ROOT, srcPath);
          try {
            rawSource += readFileSync(absSourcePath, "utf-8") + "\n";
          } catch {
            console.error(`   warning: could not read source ${srcPath}`);
          }
        }
      }
    }

    if (!rawSource) {
      // Try single-line sources: format
      const singleMatch = currentPage.match(/^sources:\s*\[([^\]]*)\]/m);
      if (singleMatch && singleMatch[1].trim()) {
        const paths = singleMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/['"]/g, ""));
        for (const srcPath of paths) {
          if (srcPath) {
            const absSourcePath = path.join(WIKI_ROOT, srcPath);
            try {
              rawSource += readFileSync(absSourcePath, "utf-8") + "\n";
            } catch {
              console.error(`   warning: could not read source ${srcPath}`);
            }
          }
        }
      }
    }

    if (!rawSource) {
      console.error(`   skipped ${pagePath} — no raw source found`);
      continue;
    }

    const prompt = loadPrompt("lint-fix", {
      mode: "rewrite",
      conventions,
      concept_slug: "",
      referencing_pages: "",
      current_page: currentPage,
      raw_source: rawSource,
    });

    if (args.dryRun) {
      console.error(
        `   [dry-run] would dispatch rewrite prompt (${prompt.length} chars)`,
      );
      continue;
    }

    try {
      const response = await dispatchTask(engine, {
        taskId: `lint-rewrite-${path.basename(pagePath, ".md")}-${Date.now()}`,
        prompt,
        wikiRoot: WIKI_ROOT,
        engineName: args.engine,
        model: args.model || undefined,
      });

      if (response.error) {
        console.error(`   error for ${pagePath}: ${response.error.message}`);
        continue;
      }

      const parsed = parseJsonResponse<{
        wiki_page_markdown: string;
        index_entry: string;
      }>(response.output);

      proposals.push({
        type: "rewrite_page",
        path: pagePath,
        content: parsed.wiki_page_markdown,
        index_entry: parsed.index_entry,
      });

      console.error(`   proposal ready: ${pagePath}`);
    } catch (e) {
      console.error(`   failed for ${pagePath}: ${(e as Error).message}`);
    }
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// Apply proposals
// ---------------------------------------------------------------------------

function applyProposals(proposals: Proposal[]): {
  concept_pages: number;
  rewrites: number;
} {
  let conceptPages = 0;
  let rewrites = 0;

  for (const proposal of proposals) {
    switch (proposal.type) {
      case "create_concept": {
        const p = proposal as ConceptProposal;
        const pagePath = `concepts/${p.slug}.md`;
        console.error(`   writing concept page: ${pagePath}`);
        writeWikiFile(pagePath, p.content);

        // Apply related_updates — add cross-references to referencing pages
        for (const update of p.related_updates) {
          if (!wikiFileExists(update.path)) {
            console.error(
              `   skipped related update: ${update.path} not found`,
            );
            continue;
          }
          let content = readWikiFile(update.path);
          // Add to frontmatter related: list if not already present
          if (!content.includes(update.add_related)) {
            content = content.replace(
              /^(related:\s*\n)/m,
              `$1  - ${update.add_related}\n`,
            );
            writeWikiFile(update.path, content);
            console.error(`   updated related in ${update.path}`);
          }
        }

        // Add to index.md
        if (p.index_entry) {
          appendToIndex(p.index_entry, "concepts");
        }

        // Append to log.md
        appendToLog(
          `Created concept page concepts/${p.slug}.md via lint --apply`,
        );

        conceptPages++;
        break;
      }

      case "rewrite_page": {
        const p = proposal as RewriteProposal;
        console.error(`   rewriting page: ${p.path}`);
        writeWikiFile(p.path, p.content);

        // Update index entry if provided
        if (p.index_entry) {
          const category = p.path.split("/")[0];
          updateIndexEntry(p.path, p.index_entry, category);
        }

        appendToLog(`Rewrote TODO page ${p.path} via lint --apply`);
        rewrites++;
        break;
      }

      case "stale_warning":
        // Stale warnings are informational only — no action
        break;
    }
  }

  return { concept_pages: conceptPages, rewrites };
}

// ---------------------------------------------------------------------------
// Index and log helpers
// ---------------------------------------------------------------------------

function appendToIndex(entry: string, category: string): void {
  const indexPath = path.join(WIKI_DIR, "index.md");
  let content = readFileSync(indexPath, "utf-8");

  const categoryHeadings: Record<string, string> = {
    ops: "## Ops",
    architecture: "## Architecture",
    training: "## Training",
    infra: "## Infra",
    tools: "## Tools",
    product: "## Product",
    concepts: "## Concepts",
  };

  const heading = categoryHeadings[category];
  if (!heading) return;

  const headingIdx = content.indexOf(heading);
  if (headingIdx === -1) {
    content += `\n\n${heading}\n\n${entry}\n`;
  } else {
    const afterHeading = content.indexOf("\n", headingIdx);
    const nextHeading = content.indexOf("\n## ", afterHeading + 1);
    const insertPos = nextHeading === -1 ? content.length : nextHeading;
    const before = content.slice(0, insertPos).trimEnd();
    const after = content.slice(insertPos);
    content = before + "\n" + entry + "\n" + after;
  }

  writeFileSync(indexPath, content, "utf-8");
}

function updateIndexEntry(
  pagePath: string,
  newEntry: string,
  category: string,
): void {
  const indexPath = path.join(WIKI_DIR, "index.md");
  let content = readFileSync(indexPath, "utf-8");

  // Try to find existing entry for this page and replace it
  const escaped = pagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entryPattern = new RegExp(`^- \\[.*\\]\\(${escaped}\\).*$`, "m");
  const match = content.match(entryPattern);

  if (match) {
    content = content.replace(entryPattern, newEntry);
    writeFileSync(indexPath, content, "utf-8");
  } else {
    // Entry doesn't exist yet — append under the correct category
    appendToIndex(newEntry, category);
  }
}

function appendToLog(message: string): void {
  const logPath = path.join(WIKI_DIR, "log.md");
  if (!existsSync(logPath)) return;

  const date = new Date().toISOString().slice(0, 10);
  const entry = `[${date}] ${message}`;
  let content = readFileSync(logPath, "utf-8");
  content = content.trimEnd() + "\n" + entry + "\n";
  writeFileSync(logPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseLintArgs();

  console.error(`Wiki:     ${WIKI_ROOT}`);
  console.error(
    `Engine:   ${args.engine}${args.model ? ` (${args.model})` : ""}`,
  );
  console.error(
    `Mode:     ${args.apply ? "apply" : args.fix ? "fix" : "report"}`,
  );
  if (args.category) console.error(`Category: ${args.category}`);
  console.error("");

  // 1. Run lw lint
  console.error("🔍 Running lw lint...");
  const report = runLint(args.category);

  const findingCounts = {
    broken_related: report.broken_related.length,
    orphan_pages: report.orphan_pages.length,
    missing_concepts: report.missing_concepts.length,
    todo_pages: report.todo_pages.length,
    stale_pages: report.freshness.stale_pages.length,
  };
  const total = Object.values(findingCounts).reduce((a, b) => a + b, 0);

  console.error(`   broken_related:  ${findingCounts.broken_related}`);
  console.error(`   orphan_pages:    ${findingCounts.orphan_pages}`);
  console.error(`   missing_concepts: ${findingCounts.missing_concepts}`);
  console.error(`   todo_pages:      ${findingCounts.todo_pages}`);
  console.error(`   stale_pages:     ${findingCounts.stale_pages}`);
  console.error(`   total:           ${total}`);
  console.error("");

  // ---------------------------------------------------------------------------
  // Report mode — output findings and exit
  // ---------------------------------------------------------------------------
  if (!args.fix) {
    console.log(JSON.stringify({ findings: findingCounts, total }, null, 2));
    return;
  }

  // ---------------------------------------------------------------------------
  // Fix mode — auto-fix simple issues
  // ---------------------------------------------------------------------------
  console.error("🔧 Auto-fixing simple issues...");

  const autoFixed: Record<string, number> = {};

  // Auto-fix broken_related
  if (report.broken_related.length > 0) {
    console.error(`\n   broken_related (${report.broken_related.length}):`);
    autoFixed.broken_related = fixBrokenRelated(report.broken_related);
  }

  // Auto-fix orphan_pages
  if (report.orphan_pages.length > 0) {
    console.error(`\n   orphan_pages (${report.orphan_pages.length}):`);
    autoFixed.orphan_pages = fixOrphanPages(report.orphan_pages);
  }

  console.error("\n   auto-fix complete.");
  console.error("");

  // ---------------------------------------------------------------------------
  // Fix mode — generate LLM proposals
  // ---------------------------------------------------------------------------
  const proposals: Proposal[] = [];

  // Missing concepts
  if (report.missing_concepts.length > 0) {
    console.error(
      `🤖 Generating concept proposals (${report.missing_concepts.length} concepts)...`,
    );
    const conceptProposals = await proposeMissingConcepts(
      report.missing_concepts,
      args,
    );
    proposals.push(...conceptProposals);
    console.error("");
  }

  // TODO pages
  if (report.todo_pages.length > 0) {
    console.error(
      `🤖 Generating rewrite proposals (${report.todo_pages.length} TODO pages)...`,
    );
    const rewriteProposals = await proposeTodoRewrites(report.todo_pages, args);
    proposals.push(...rewriteProposals);
    console.error("");
  }

  // Stale pages — collect as warnings only
  if (report.freshness.stale_pages.length > 0) {
    proposals.push({
      type: "stale_warning",
      paths: report.freshness.stale_pages,
    });
  }

  // ---------------------------------------------------------------------------
  // Fix mode (no --apply) — output proposals as JSON
  // ---------------------------------------------------------------------------
  if (!args.apply) {
    const output = {
      auto_fixed: autoFixed,
      proposals: proposals
        .filter((p) => p.type !== "stale_warning")
        .map((p) => {
          if (p.type === "create_concept") {
            const cp = p as ConceptProposal;
            return {
              type: cp.type,
              slug: cp.slug,
              references: cp.related_updates.length,
              preview: cp.content.slice(0, 200),
            };
          }
          if (p.type === "rewrite_page") {
            const rp = p as RewriteProposal;
            return {
              type: rp.type,
              path: rp.path,
              preview: rp.content.slice(0, 200),
            };
          }
          return p;
        }),
      stale_warnings: report.freshness.stale_pages,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ---------------------------------------------------------------------------
  // Apply mode — execute proposals
  // ---------------------------------------------------------------------------
  console.error("📝 Applying proposals...");
  const applied = applyProposals(proposals);

  console.error(
    `\n   applied: ${applied.concept_pages} concept pages, ${applied.rewrites} rewrites`,
  );
  console.error("");

  // Re-run lint to verify
  console.error("🔍 Re-running lw lint to verify...");
  let lintAfter: string;
  try {
    const verifyReport = runLint(args.category);
    const remaining =
      verifyReport.broken_related.length +
      verifyReport.orphan_pages.length +
      verifyReport.missing_concepts.length +
      verifyReport.todo_pages.length;
    lintAfter =
      remaining === 0 ? "All clear!" : `${remaining} findings remaining`;
    console.error(`   ${lintAfter}`);
  } catch (e) {
    lintAfter = `lint re-run failed: ${(e as Error).message}`;
    console.error(`   ${lintAfter}`);
  }

  // Output summary
  const output = {
    auto_fixed: autoFixed,
    applied: {
      concept_pages: applied.concept_pages,
      rewrites: applied.rewrites,
    },
    stale_warnings: report.freshness.stale_pages,
    lint_after: lintAfter,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
