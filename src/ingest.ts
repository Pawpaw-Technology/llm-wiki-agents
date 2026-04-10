#!/usr/bin/env tsx
/**
 * Wiki Ingest Agent
 *
 * Batch-ingest raw source files into wiki pages via LLM.
 * Each source gets a full wiki page (frontmatter + structured body + cross-references),
 * with index.md and log.md updated after each page.
 *
 * Usage:
 *   npm run ingest                                    # auto-scan raw/
 *   npm run ingest -- --source "raw/articles/foo.md"  # explicit source
 *   npm run ingest -- --batch 5 --dry-run             # preview 5 sources
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import {
  WIKI_ROOT,
  createEngine,
  parseBaseArgs,
  parseJsonResponse,
  loadPrompt,
  dispatchTask,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Categories (same as classify.ts — concepts excluded per spec)
// ---------------------------------------------------------------------------

const CATEGORIES = [
  "architecture",
  "training",
  "infra",
  "tools",
  "product",
  "ops",
];

// ---------------------------------------------------------------------------
// CLI argument parsing (extends BaseArgs with --source)
// ---------------------------------------------------------------------------

interface IngestArgs {
  engine: string;
  model: string;
  batch: number;
  dryRun: boolean;
  source: string | null;
}

function parseIngestArgs(): IngestArgs {
  const base = parseBaseArgs({ batch: 10 });
  let source: string | null = null;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" || args[i] === "-s") {
      source = args[++i];
    }
  }

  return { ...base, source };
}

// ---------------------------------------------------------------------------
// Engine response schema
// ---------------------------------------------------------------------------

interface IngestResponse {
  slug: string;
  category: string;
  wiki_page_markdown: string;
  index_entry: string;
  log_entry: string;
  related_updates: Array<{
    path: string;
    add_related: string;
  }>;
}

// ---------------------------------------------------------------------------
// Stdout detail records
// ---------------------------------------------------------------------------

interface IngestDetail {
  source: string;
  status: "created" | "skipped" | "failed";
  page?: string;
  reason?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Wiki file helpers
// ---------------------------------------------------------------------------

function readWikiFile(relPath: string): string {
  const absPath = path.join(WIKI_ROOT, "wiki", relPath);
  return readFileSync(absPath, "utf-8");
}

function writeWikiFile(relPath: string, content: string): void {
  const absPath = path.join(WIKI_ROOT, "wiki", relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf-8");
}

function wikiFileExists(relPath: string): boolean {
  return existsSync(path.join(WIKI_ROOT, "wiki", relPath));
}

function readRawFile(relPath: string): string {
  const absPath = path.join(WIKI_ROOT, relPath);
  return readFileSync(absPath, "utf-8");
}

function readConventions(): string {
  const claudeMdPath = path.join(WIKI_ROOT, "CLAUDE.md");
  return readFileSync(claudeMdPath, "utf-8");
}

function readIndex(): string {
  return readWikiFile("index.md");
}

// ---------------------------------------------------------------------------
// Source scanning: find raw sources not yet ingested
// ---------------------------------------------------------------------------

/**
 * Collect all `sources:` values referenced across every wiki page.
 * Scans all .md files under wiki/ category directories.
 */
function collectIngestedSources(): Set<string> {
  const ingested = new Set<string>();
  const wikiDir = path.join(WIKI_ROOT, "wiki");

  for (const category of [...CATEGORIES, "concepts", "_uncategorized"]) {
    const catDir = path.join(wikiDir, category);
    if (!existsSync(catDir)) continue;

    let files: string[];
    try {
      files = execSync(`find "${catDir}" -name "*.md" -type f`, {
        encoding: "utf-8",
        timeout: 10_000,
      })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        // Extract sources: from frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        const fm = fmMatch[1];
        // Match sources: list items (YAML list under sources:)
        const sourcesMatch = fm.match(/^sources:\s*\n((?:\s+-\s+.*\n?)*)/m);
        if (sourcesMatch) {
          const lines = sourcesMatch[1].split("\n");
          for (const line of lines) {
            const m = line.match(/^\s+-\s+(.+)/);
            if (m) ingested.add(m[1].trim());
          }
        }
        // Also match inline sources: [item] or sources: - item on same line
        const inlineMatch = fm.match(/^sources:\s*\[([^\]]*)\]/m);
        if (inlineMatch && inlineMatch[1].trim()) {
          for (const s of inlineMatch[1].split(",")) {
            ingested.add(s.trim());
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return ingested;
}

/**
 * Scan raw/**\/*.{md,json} and return paths not already ingested.
 */
function scanRawSources(batch: number): string[] {
  const rawDir = path.join(WIKI_ROOT, "raw");
  if (!existsSync(rawDir)) {
    console.error("   No raw/ directory found. Nothing to ingest.");
    return [];
  }

  let allRaw: string[];
  try {
    allRaw = execSync(
      `find "${rawDir}" -type f \\( -name "*.md" -o -name "*.json" \\)`,
      { encoding: "utf-8", timeout: 10_000 },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((absPath) => path.relative(WIKI_ROOT, absPath));
  } catch {
    return [];
  }

  const ingested = collectIngestedSources();
  const unprocessed = allRaw.filter((p) => !ingested.has(p));

  console.error(
    `   Found ${allRaw.length} raw files, ${ingested.size} already ingested, ${unprocessed.length} remaining`,
  );

  return unprocessed.slice(0, batch);
}

/**
 * Expand an explicit --source argument (may be a glob or a single path).
 */
function expandSource(source: string): string[] {
  // Try glob expansion via shell
  try {
    const expanded = execSync(
      `cd "${WIKI_ROOT}" && ls -1 ${source} 2>/dev/null`,
      { encoding: "utf-8", timeout: 5_000 },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (expanded.length > 0) return expanded;
  } catch {
    // fall through
  }

  // If it's a single path that exists
  if (existsSync(path.join(WIKI_ROOT, source))) {
    return [source];
  }

  // Absolute path check
  if (existsSync(source)) {
    return [path.relative(WIKI_ROOT, source)];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateResponse(
  resp: IngestResponse,
  sourcePath: string,
): string | null {
  // slug <= 60 chars
  if (resp.slug.length > 60) {
    return `slug "${resp.slug}" exceeds 60 characters (${resp.slug.length})`;
  }

  // valid category
  if (!CATEGORIES.includes(resp.category)) {
    return `invalid category "${resp.category}" (must be one of: ${CATEGORIES.join(", ")})`;
  }

  // wiki_page_markdown starts with ---
  if (!resp.wiki_page_markdown.trimStart().startsWith("---")) {
    return "wiki_page_markdown does not start with frontmatter (---)";
  }

  // related_updates paths must exist
  if (resp.related_updates && resp.related_updates.length > 0) {
    for (const update of resp.related_updates) {
      if (!wikiFileExists(update.path)) {
        return `related_updates path "${update.path}" does not exist`;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Apply related updates to existing pages
// ---------------------------------------------------------------------------

function applyRelatedUpdates(updates: IngestResponse["related_updates"]): void {
  for (const update of updates) {
    if (!wikiFileExists(update.path)) {
      console.error(
        `   \u26a0\ufe0f  Skipping related update: ${update.path} not found`,
      );
      continue;
    }

    const content = readWikiFile(update.path);
    const relatedEntry = update.add_related;

    // Check if already referenced
    if (content.includes(relatedEntry)) {
      console.error(
        `   \u2022 ${update.path} already references ${relatedEntry}`,
      );
      continue;
    }

    // Add to related: frontmatter list
    const fmMatch = content.match(
      /^(---\n[\s\S]*?)(related:\s*\n(?:\s+-\s+.*\n?)*)([\s\S]*)/,
    );
    if (fmMatch) {
      const updated =
        fmMatch[1] +
        fmMatch[2].trimEnd() +
        `\n  - ${relatedEntry}\n` +
        fmMatch[3];
      writeWikiFile(update.path, updated);
      console.error(
        `   \u2714 Added ${relatedEntry} to ${update.path} related: list`,
      );
    } else {
      // Try inserting related: before closing ---
      const fmEndMatch = content.match(/^(---\n[\s\S]*?)\n(---)/);
      if (fmEndMatch) {
        const updated =
          fmEndMatch[1] +
          `\nrelated:\n  - ${relatedEntry}\n` +
          fmEndMatch[2] +
          content.slice(fmEndMatch[0].length);
        writeWikiFile(update.path, updated);
        console.error(
          `   \u2714 Created related: in ${update.path} with ${relatedEntry}`,
        );
      } else {
        console.error(
          `   \u26a0\ufe0f  Could not update related: in ${update.path} (no frontmatter)`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Append to index.md and log.md
// ---------------------------------------------------------------------------

function appendToIndex(indexEntry: string): void {
  const indexPath = path.join(WIKI_ROOT, "wiki", "index.md");
  const content = readFileSync(indexPath, "utf-8");
  writeFileSync(
    indexPath,
    content.trimEnd() + "\n" + indexEntry + "\n",
    "utf-8",
  );
}

function appendToLog(logEntry: string): void {
  const logPath = path.join(WIKI_ROOT, "wiki", "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `[${date}] ${logEntry}`;

  if (existsSync(logPath)) {
    const content = readFileSync(logPath, "utf-8");
    writeFileSync(logPath, content.trimEnd() + "\n" + entry + "\n", "utf-8");
  } else {
    writeFileSync(logPath, `# Wiki Log\n\n${entry}\n`, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseIngestArgs();
  const engine = createEngine(args.engine);

  console.error(`\ud83d\udcda Wiki Ingest Agent`);
  console.error(`Wiki:   ${WIKI_ROOT}`);
  console.error(
    `Engine: ${args.engine}${args.model ? ` (${args.model})` : ""}`,
  );
  console.error(`Batch:  ${args.batch}`);
  if (args.dryRun) console.error(`Mode:   DRY RUN`);
  console.error("");

  // 1. Load conventions
  console.error("\ud83d\udcc4 Loading wiki conventions...");
  const conventions = readConventions();
  console.error(`   CLAUDE.md: ${conventions.length} chars`);

  // 2. Build source list
  console.error("\n\ud83d\udd0d Building source list...");
  let sources: string[];

  if (args.source) {
    sources = expandSource(args.source);
    if (sources.length === 0) {
      console.error(`   \u274c No files matched --source "${args.source}"`);
      console.log(
        JSON.stringify({ created: 0, skipped: 0, failed: 0, details: [] }),
      );
      process.exit(0);
    }
    sources = sources.slice(0, args.batch);
    console.error(`   Using explicit sources: ${sources.length} file(s)`);
  } else {
    sources = scanRawSources(args.batch);
    if (sources.length === 0) {
      console.error("   \u2705 All raw sources already ingested. Done.");
      console.log(
        JSON.stringify({ created: 0, skipped: 0, failed: 0, details: [] }),
      );
      process.exit(0);
    }
  }

  console.error("");
  for (const s of sources) {
    console.error(`   \u2022 ${s}`);
  }
  console.error("");

  // Dry run: show what would be processed
  if (args.dryRun) {
    const details: IngestDetail[] = sources.map((s) => ({
      source: s,
      status: "skipped" as const,
      reason: "dry-run",
    }));
    console.error(`\u2705 DRY RUN: Would process ${sources.length} source(s).`);
    console.error("");

    // Show a prompt preview for the first source
    if (sources.length > 0) {
      const index = readIndex();
      const sourceContent = readRawFile(sources[0]);
      const prompt = loadPrompt("ingest", {
        conventions,
        index,
        source_path: sources[0],
        source_content: sourceContent,
      });
      console.error("--- Prompt preview (first source, truncated) ---");
      console.error(prompt.slice(0, 2000) + "...");
      console.error("");
    }

    console.log(
      JSON.stringify({
        created: 0,
        skipped: sources.length,
        failed: 0,
        details,
      }),
    );
    process.exit(0);
  }

  // 3. Sequential processing
  const details: IngestDetail[] = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < sources.length; i++) {
    const sourcePath = sources[i];
    console.error(
      `\n\ud83d\udce6 [${i + 1}/${sources.length}] Processing: ${sourcePath}`,
    );

    try {
      // Re-read index.md fresh (may have been updated by prior iteration)
      const index = readIndex();

      // Read raw source content
      let sourceContent: string;
      try {
        sourceContent = readRawFile(sourcePath);
      } catch (e) {
        const msg = `Cannot read source: ${(e as Error).message}`;
        console.error(`   \u274c ${msg}`);
        details.push({ source: sourcePath, status: "failed", error: msg });
        failed++;
        continue;
      }
      console.error(`   Source: ${sourceContent.length} chars`);

      // Build prompt
      const prompt = loadPrompt("ingest", {
        conventions,
        index,
        source_path: sourcePath,
        source_content: sourceContent,
      });
      console.error(`   Prompt: ${prompt.length} chars`);

      // Dispatch via codebridge
      console.error(
        `   \ud83e\udd16 Calling ${args.engine}${args.model ? ` (${args.model})` : ""}...`,
      );
      const startTime = Date.now();
      const response = await dispatchTask(engine, {
        taskId: `ingest-${Date.now()}`,
        prompt,
        wikiRoot: WIKI_ROOT,
        engineName: args.engine,
        model: args.model || undefined,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`   Done in ${elapsed}s`);

      if (response.error) {
        const msg = `LLM error: ${response.error.message}`;
        console.error(`   \u274c ${msg}`);
        if (response.stderr) {
          console.error(`   stderr: ${response.stderr.slice(0, 500)}`);
        }
        details.push({ source: sourcePath, status: "failed", error: msg });
        failed++;
        continue;
      }

      // Parse JSON response
      let result: IngestResponse;
      try {
        result = parseJsonResponse<IngestResponse>(response.output);
      } catch (e) {
        const msg = `Parse error: ${(e as Error).message}`;
        console.error(`   \u274c ${msg}`);
        console.error(
          `   Raw output (first 500 chars): ${response.output.slice(0, 500)}`,
        );
        details.push({ source: sourcePath, status: "failed", error: msg });
        failed++;
        continue;
      }

      // Validate response
      const validationError = validateResponse(result, sourcePath);
      if (validationError) {
        console.error(`   \u274c Validation failed: ${validationError}`);
        details.push({
          source: sourcePath,
          status: "failed",
          error: `Validation: ${validationError}`,
        });
        failed++;
        continue;
      }

      // Write wiki page
      const pagePath = `${result.category}/${result.slug}.md`;
      console.error(`   \ud83d\udcdd Writing: wiki/${pagePath}`);
      try {
        writeWikiFile(pagePath, result.wiki_page_markdown);
      } catch (e) {
        // File write failure: abort entire run
        console.error(
          `\n\u274c FATAL: File write failed: ${(e as Error).message}`,
        );
        console.error("   Aborting run (filesystem error is not recoverable).");
        details.push({
          source: sourcePath,
          status: "failed",
          error: `File write failed: ${(e as Error).message}`,
        });
        failed++;
        console.log(JSON.stringify({ created, skipped, failed, details }));
        process.exit(1);
      }

      // Apply related updates
      if (result.related_updates && result.related_updates.length > 0) {
        console.error(
          `   \ud83d\udd17 Applying ${result.related_updates.length} related update(s)...`,
        );
        try {
          applyRelatedUpdates(result.related_updates);
        } catch (e) {
          // Related update write failure: abort
          console.error(
            `\n\u274c FATAL: Related update write failed: ${(e as Error).message}`,
          );
          console.error(
            "   Aborting run (filesystem error is not recoverable).",
          );
          details.push({
            source: sourcePath,
            status: "failed",
            error: `Related update write failed: ${(e as Error).message}`,
          });
          failed++;
          console.log(JSON.stringify({ created, skipped, failed, details }));
          process.exit(1);
        }
      }

      // Append to index.md
      console.error(`   \ud83d\udcc7 Updating index.md`);
      try {
        appendToIndex(result.index_entry);
      } catch (e) {
        console.error(
          `\n\u274c FATAL: Index write failed: ${(e as Error).message}`,
        );
        details.push({
          source: sourcePath,
          status: "failed",
          error: `Index write failed: ${(e as Error).message}`,
        });
        failed++;
        console.log(JSON.stringify({ created, skipped, failed, details }));
        process.exit(1);
      }

      // Append to log.md
      console.error(`   \ud83d\udcdd Updating log.md`);
      try {
        appendToLog(result.log_entry);
      } catch (e) {
        console.error(
          `\n\u274c FATAL: Log write failed: ${(e as Error).message}`,
        );
        details.push({
          source: sourcePath,
          status: "failed",
          error: `Log write failed: ${(e as Error).message}`,
        });
        failed++;
        console.log(JSON.stringify({ created, skipped, failed, details }));
        process.exit(1);
      }

      // Success
      console.error(`   \u2705 Created: ${pagePath}`);
      details.push({
        source: sourcePath,
        status: "created",
        page: pagePath,
      });
      created++;
    } catch (e) {
      // Catch-all for unexpected errors in a single source
      const msg = `Unexpected error: ${(e as Error).message}`;
      console.error(`   \u274c ${msg}`);
      details.push({ source: sourcePath, status: "failed", error: msg });
      failed++;
    }
  }

  // 4. Output summary
  console.error(
    `\n\ud83d\udcca Summary: ${created} created, ${skipped} skipped, ${failed} failed`,
  );
  console.log(JSON.stringify({ created, skipped, failed, details }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
