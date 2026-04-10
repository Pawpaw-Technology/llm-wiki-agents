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
import { readFileSync } from "node:fs";
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

export function parseJsonResponse<T>(output: string): T {
  // Tier 1: direct parse
  try {
    return JSON.parse(output) as T;
  } catch {}

  // Tier 2: markdown code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]) as T;
    } catch {}
  }

  // Tier 3a: array bracket search
  const arrStart = output.indexOf("[");
  const arrEnd = output.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      return JSON.parse(output.slice(arrStart, arrEnd + 1)) as T;
    } catch {}
  }

  // Tier 3b: object bracket search
  const objStart = output.indexOf("{");
  const objEnd = output.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    try {
      return JSON.parse(output.slice(objStart, objEnd + 1)) as T;
    } catch {}
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
