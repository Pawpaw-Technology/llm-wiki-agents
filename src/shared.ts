/**
 * shared.ts — Common utilities for all llm-wiki agents
 *
 * Extracted from classify.ts. Provides:
 *   - BaseArgs interface + parseBaseArgs()
 *   - WIKI_ROOT constant
 *   - lw() CLI wrapper
 *   - createEngine() factory
 *   - parseJsonResponse<T>() — handles both [] and {} responses
 *   - loadPrompt() — template loading with {{placeholder}} replacement
 *   - dispatchTask() — standard codebridge task submission
 */

import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeEngine } from "codebridge/src/engines/claude-code.js";
import { KimiCodeEngine } from "codebridge/src/engines/kimi-code.js";
import { CodexEngine } from "codebridge/src/engines/codex.js";
import { OpenCodeEngine } from "codebridge/src/engines/opencode.js";
import type { Engine, EngineResponse } from "codebridge/src/core/engine.js";

export type { Engine, EngineResponse };

// ---------------------------------------------------------------------------
// WIKI_ROOT
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WIKI_ROOT: string =
  process.env.LW_WIKI_ROOT ||
  process.env.WIKI_ROOT ||
  path.resolve(__dirname, "../../wiki");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface BaseArgs {
  engine: string;
  model: string;
  batch: number;
  dryRun: boolean;
}

export function parseBaseArgs(defaults: Partial<BaseArgs>): BaseArgs {
  const args = process.argv.slice(2);
  const opts: BaseArgs = {
    engine: defaults.engine ?? "claude-code",
    model: defaults.model ?? "",
    batch: defaults.batch ?? 20,
    dryRun: defaults.dryRun ?? false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--engine":
      case "-e":
        opts.engine = args[++i];
        break;
      case "--model":
      case "-m":
        opts.model = args[++i];
        break;
      case "--batch":
      case "-b":
        opts.batch = parseInt(args[++i], 10);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// lw CLI wrapper
// ---------------------------------------------------------------------------

export function lw(cmd: string): string {
  return execSync(`lw ${cmd} --root "${WIKI_ROOT}"`, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

export function createEngine(name: string): Engine {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeEngine();
    case "kimi-code":
      return new KimiCodeEngine();
    case "codex":
      return new CodexEngine();
    case "opencode":
      return new OpenCodeEngine();
    default:
      throw new Error(
        `Unknown engine: ${name}. Supported: claude-code, kimi-code, codex, opencode`,
      );
  }
}

// ---------------------------------------------------------------------------
// JSON response parsing
// ---------------------------------------------------------------------------

/**
 * Fix raw newlines inside JSON string values.
 * LLMs often output {"key":"line1\nline2"} with actual newline chars,
 * which is illegal JSON (must be \\n). This repairs them.
 */
function fixRawNewlinesInJson(text: string): string {
  // Replace raw newlines that appear inside JSON string values.
  // Strategy: walk through the string tracking quote state.
  let result = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && ch === "\n") {
      result += "\\n";
      continue;
    }
    if (inString && ch === "\r") {
      result += "\\r";
      continue;
    }
    if (inString && ch === "\t") {
      result += "\\t";
      continue;
    }
    result += ch;
  }
  return result;
}

function tryParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {}
  // Retry with newline fix
  try {
    return JSON.parse(fixRawNewlinesInJson(text)) as T;
  } catch {}
  return undefined;
}

export function parseJsonResponse<T>(output: string): T {
  // Tier 1: direct parse
  const t1 = tryParse<T>(output);
  if (t1 !== undefined) return t1;

  // Tier 2: markdown code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const t2 = tryParse<T>(codeBlockMatch[1]);
    if (t2 !== undefined) return t2;
  }

  // Tier 3a: array bracket search
  const arrStart = output.indexOf("[");
  const arrEnd = output.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    const t3a = tryParse<T>(output.slice(arrStart, arrEnd + 1));
    if (t3a !== undefined) return t3a;
  }

  // Tier 3b: object bracket search
  const objStart = output.indexOf("{");
  const objEnd = output.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    const t3b = tryParse<T>(output.slice(objStart, objEnd + 1));
    if (t3b !== undefined) return t3b;
  }

  throw new Error("Could not parse LLM response as JSON");
}

// ---------------------------------------------------------------------------
// Prompt template loading
// ---------------------------------------------------------------------------

export function loadPrompt(name: string, vars: Record<string, string>): string {
  const templatePath = path.join(__dirname, "../prompts", `${name}.md`);
  let template = readFileSync(templatePath, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  return template;
}

// ---------------------------------------------------------------------------
// Standard task dispatch
// ---------------------------------------------------------------------------

export async function dispatchTask(
  engine: Engine,
  opts: {
    taskId: string;
    prompt: string;
    wikiRoot: string;
    engineName: string;
    model?: string;
    timeoutMs?: number;
  },
): Promise<EngineResponse> {
  return engine.start({
    task_id: opts.taskId,
    intent: "ops",
    workspace_path: opts.wikiRoot,
    message: opts.prompt,
    engine: opts.engineName as any,
    model: opts.model || undefined,
    mode: "new",
    session_id: null,
    constraints: {
      timeout_ms: opts.timeoutMs ?? 300_000,
      allow_network: true,
    },
    images: [],
  });
}

// ---------------------------------------------------------------------------
// Wiki categories
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  "architecture",
  "training",
  "infra",
  "tools",
  "product",
  "ops",
];

// ---------------------------------------------------------------------------
// Wiki file I/O
// ---------------------------------------------------------------------------

const WIKI_DIR = path.join(WIKI_ROOT, "wiki");

export function readWikiFile(relPath: string): string {
  return readFileSync(path.join(WIKI_DIR, relPath), "utf-8");
}

export function writeWikiFile(relPath: string, content: string): void {
  const absPath = path.join(WIKI_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf-8");
}

export function wikiFileExists(relPath: string): boolean {
  return existsSync(path.join(WIKI_DIR, relPath));
}

export function readConventions(): string {
  return readFileSync(path.join(WIKI_ROOT, "CLAUDE.md"), "utf-8");
}

export function readIndex(): string {
  return readFileSync(path.join(WIKI_DIR, "index.md"), "utf-8");
}

export function appendToLog(message: string): void {
  const logPath = path.join(WIKI_DIR, "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `\n## [${date}] ${message}\n`;
  if (!existsSync(logPath)) {
    writeFileSync(logPath, `# Wiki Log\n${entry}`, "utf-8");
  } else {
    const content = readFileSync(logPath, "utf-8");
    const insertPos = content.indexOf("\n## ");
    if (insertPos !== -1) {
      writeFileSync(
        logPath,
        content.slice(0, insertPos) + entry + content.slice(insertPos),
        "utf-8",
      );
    } else {
      appendFileSync(logPath, entry, "utf-8");
    }
  }
}

export function appendToIndex(entry: string, category: string): void {
  const indexPath = path.join(WIKI_DIR, "index.md");
  let content = readFileSync(indexPath, "utf-8");

  const headingMap: Record<string, string> = {
    ops: "## Ops",
    architecture: "## Architecture",
    training: "## Training",
    infra: "## Infra",
    tools: "## Tools",
    product: "## Product",
    concepts: "## Concepts",
  };

  const heading = headingMap[category];
  if (!heading) {
    content = content.trimEnd() + "\n" + entry + "\n";
  } else {
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
  }

  writeFileSync(indexPath, content, "utf-8");
}
