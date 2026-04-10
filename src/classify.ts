#!/usr/bin/env tsx
/**
 * Wiki Classification Agent
 *
 * Reads uncategorized pages via `lw` CLI, sends to LLM via codebridge engine,
 * writes classified pages back via `lw` CLI.
 *
 * Usage:
 *   npm run classify                              # default: claude-code
 *   npm run classify -- --engine kimi-code         # use kimi
 *   npm run classify -- --batch 10 --dry-run       # preview 10 pages
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Config
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
// Page I/O
// ---------------------------------------------------------------------------

interface PageEntry {
  path: string;
  title: string;
  tags: string[];
  category: string;
}

function getUncategorizedPages(limit: number): PageEntry[] {
  const raw = lw(
    `query "" --category _uncategorized --format json --limit ${limit}`,
  );
  const envelope = JSON.parse(raw);
  return envelope.results || [];
}

function readPage(pagePath: string): string {
  const absPath = path.join(WIKI_ROOT, "wiki", pagePath);
  return readFileSync(absPath, "utf-8");
}

function writePage(pagePath: string, content: string): void {
  const absPath = path.join(WIKI_ROOT, "wiki", pagePath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Classification {
  path: string;
  category: string;
  tags: string[];
  decay: string;
}

function buildPrompt(
  pages: { path: string; title: string; body: string }[],
): string {
  const pagesJson = JSON.stringify(
    pages.map((p) => ({
      path: p.path,
      title: p.title,
      body: p.body.slice(0, 200),
    })),
    null,
    2,
  );
  return loadPrompt("classify", {
    categories: CATEGORIES.join(", "),
    pages: pagesJson,
  });
}

function updatePageFrontmatter(
  content: string,
  classification: Classification,
): string {
  let updated = content;

  // Update tags
  if (classification.tags.length > 0) {
    const tagStr = `[${classification.tags.join(", ")}]`;
    if (updated.match(/^tags:\s*\[.*\]/m)) {
      updated = updated.replace(/^tags:\s*\[.*\]/m, `tags: ${tagStr}`);
    } else if (updated.match(/^tags:\s*$/m)) {
      updated = updated.replace(/^tags:\s*$/m, `tags: ${tagStr}`);
    } else {
      updated = updated.replace(/^(title:.*\n)/m, `$1tags: ${tagStr}\n`);
    }
  }

  // Update decay
  if (classification.decay) {
    if (updated.match(/^decay:\s*.*/m)) {
      updated = updated.replace(
        /^decay:\s*.*/m,
        `decay: ${classification.decay}`,
      );
    } else {
      updated = updated.replace(
        /^(tags:.*\n)/m,
        `$1decay: ${classification.decay}\n`,
      );
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseBaseArgs({ batch: 20 });
  const engine = createEngine(args.engine);

  console.error(`Wiki:   ${WIKI_ROOT}`);
  console.error(
    `Engine: ${args.engine}${args.model ? ` (${args.model})` : ""}`,
  );
  console.error(`Batch:  ${args.batch}`);
  console.error("");

  // 1. Get uncategorized pages
  console.error("📋 Fetching uncategorized pages...");
  const pages = getUncategorizedPages(args.batch);
  if (pages.length === 0) {
    console.error("✅ No uncategorized pages. Done.");
    process.exit(0);
  }
  console.error(`   Found ${pages.length} uncategorized pages:\n`);
  for (const p of pages) {
    const shortTitle =
      p.title.length > 50 ? p.title.slice(0, 50) + "..." : p.title;
    console.error(`   - ${shortTitle}`);
  }
  console.error("");

  // 2. Read page contents
  console.error("📖 Reading page contents...");
  const pageContents = pages.map((p, i) => {
    console.error(`   [${i + 1}/${pages.length}] ${p.path}`);
    return {
      path: p.path,
      title: p.title,
      body: readPage(p.path),
    };
  });
  console.error("");

  // 3. Build prompt and call LLM
  const prompt = buildPrompt(pageContents);
  console.error(
    `📝 Prompt: ${prompt.length} chars, ${pageContents.length} pages`,
  );

  if (args.dryRun) {
    console.error("\n--- DRY RUN: Prompt preview ---");
    console.error(prompt.slice(0, 2000) + "...");
    console.error(`\n✅ Would classify ${pages.length} pages. Exiting.`);
    process.exit(0);
  }

  console.error(
    `\n🤖 Calling ${args.engine}${args.model ? ` (${args.model})` : ""}...`,
  );
  const startTime = Date.now();
  const response = await dispatchTask(engine, {
    taskId: `classify-${Date.now()}`,
    prompt,
    wikiRoot: WIKI_ROOT,
    engineName: args.engine,
    model: args.model || undefined,
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`   Done in ${elapsed}s`);

  if (response.error) {
    console.error(`\n❌ LLM error: ${response.error.message}`);
    if (response.stderr)
      console.error(`   stderr: ${response.stderr.slice(0, 500)}`);
    process.exit(1);
  }

  // 4. Parse classifications
  let classifications: Classification[];
  try {
    classifications = parseJsonResponse<Classification[]>(response.output);
  } catch (e) {
    console.error(`\n❌ Parse error: ${(e as Error).message}`);
    console.error(
      "   Raw output (first 1000 chars):",
      response.output.slice(0, 1000),
    );
    process.exit(1);
  }

  console.error(`   Parsed ${classifications.length} classifications.\n`);

  // 5. Apply classifications
  console.error("📂 Applying classifications:");
  let moved = 0;
  let skipped = 0;
  for (const cls of classifications) {
    if (!CATEGORIES.includes(cls.category)) {
      console.error(`  skip: ${cls.path} — invalid category "${cls.category}"`);
      skipped++;
      continue;
    }

    const oldPath = cls.path;
    const filename = path.basename(oldPath);
    const newPath = `${cls.category}/${filename}`;

    try {
      const content = readPage(oldPath);
      const updated = updatePageFrontmatter(content, cls);
      writePage(newPath, updated);
      moved++;
      console.error(
        `   ✅ [${moved}] ${oldPath} → ${newPath}  [${cls.tags.join(", ")}] ${cls.decay}`,
      );
    } catch (e) {
      console.error(`   ❌ ${oldPath} — ${(e as Error).message}`);
      skipped++;
    }
  }

  // Summary
  console.error(
    `\n📊 Summary: ${moved} classified, ${skipped} skipped, ${pages.length} total`,
  );

  // Machine-readable output to stdout
  console.log(
    JSON.stringify({ classified: moved, skipped, total: pages.length }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
