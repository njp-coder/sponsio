import { summarize } from "./diff.js";
import { buildValidInput } from "./conformance.js";
import type { LiveTool, InvocationResult } from "./capture.js";
import type { DiffResult, Finding } from "./types.js";

export interface ResponseOptions {
  includeUnsafe?: boolean;
}

/**
 * WebMCP has no `outputSchema`. A tool's response is entirely untyped, so the
 * half of the contract an agent actually consumes is undeclared and undiffable —
 * the shape can change on any deploy and nothing anywhere will say so.
 *
 * Two properties are still measurable by calling the tool: whether the shape is
 * stable between identical calls, and whether a response that reports success
 * actually contains a failure.
 */
export async function auditResponses(
  tools: LiveTool[],
  options: ResponseOptions = {},
): Promise<DiffResult> {
  const findings: Finding[] = [];
  const candidates = tools.filter(
    (tool) => options.includeUnsafe || tool.annotations?.readOnly === true,
  );

  for (const tool of candidates) {
    const input = buildValidInput(tool.inputSchema ?? {});
    const first = await tool.execute(input);
    const second = await tool.execute(input);

    if (first.status !== "Completed") continue;

    checkFalseSuccess(tool.name, first, findings);
    checkStability(tool.name, first, second, findings);
    checkStructure(tool.name, first, findings);
  }

  return summarize(findings);
}

/**
 * The worst failure an agent can meet: a call that reports success and carries
 * a failure inside it. The agent believes the work is done and moves on, so the
 * error surfaces later as something inexplicable, or never.
 */
function checkFalseSuccess(tool: string, result: InvocationResult, findings: Finding[]): void {
  const evidence = errorInside(result.output);
  if (!evidence) return;

  findings.push({
    severity: "breaking",
    code: "FALSE_SUCCESS",
    tool,
    message:
      `Reported success while returning ${evidence}. An agent takes the status at ` +
      `face value and moves on, so this failure is invisible until something later ` +
      `makes no sense. Return an error status instead.`,
  });
}

/** Only trusts an unambiguous error signal — a dedicated key, or text that opens with one. */
function errorInside(output: unknown): string | undefined {
  const text = extractText(output);

  if (output && typeof output === "object" && !Array.isArray(output)) {
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
      if (/^(error|errors|err|failure)$/i.test(key) && value != null && value !== false) {
        return `an \`${key}\` field`;
      }
    }
  }

  if (text && OPENS_WITH_ERROR.test(text)) return `a message beginning "${text.slice(0, 40).trim()}…"`;
  return undefined;
}

const OPENS_WITH_ERROR =
  /^\s*(error|failed|failure|invalid|unauthori[sz]ed|forbidden|denied|not found|cannot|could not|unable to|missing required)\b/i;

/**
 * Two identical calls that come back shaped differently mean no agent can build
 * against this — and no baseline can catch it changing, since it never settled.
 */
function checkStability(
  tool: string,
  first: InvocationResult,
  second: InvocationResult,
  findings: Finding[],
): void {
  if (second.status !== "Completed") return;

  const a = shapeOf(first.output);
  const b = shapeOf(second.output);
  if (compatible(a, b)) return;

  findings.push({
    severity: "warning",
    code: "UNSTABLE_RESPONSE",
    tool,
    message:
      `Two identical calls returned differently shaped responses (${a} then ${b}). ` +
      `An agent cannot rely on a shape that changes between calls.`,
  });
}

/**
 * Prose is a legitimate response for some tools and a liability for others: a
 * model re-parsing free text every call is a silent source of extraction errors.
 */
function checkStructure(tool: string, result: InvocationResult, findings: Finding[]): void {
  const text = extractText(result.output);
  if (!text || text.length < 40) return;
  if (looksStructured(text)) return;

  findings.push({
    severity: "warning",
    code: "UNSTRUCTURED_RESPONSE",
    tool,
    message:
      `Returns ${text.length} characters of free text with no structure, so every ` +
      `agent must re-parse prose to use it. Return JSON where the answer is data.`,
  });
}

function looksStructured(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Pulls the human-readable payload out of either a bare value or MCP content blocks. */
function extractText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return undefined;

  const content = (output as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        if (!block || typeof block !== "object") return undefined;
        const record = block as Record<string, unknown>;
        const value = record["text"] ?? record["value"];
        return typeof value === "string" ? value : undefined;
      })
      .filter((part): part is string => part !== undefined);
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}

/**
 * A structural fingerprint. Array element counts are ignored — a search
 * returning three results then five is stable; one returning objects then
 * strings is not. Empty collections become a wildcard rather than a mismatch.
 */
export function shapeOf(value: unknown, depth = 0): string {
  if (depth > 6) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[?]" : `[${shapeOf(value[0], depth + 1)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => `${key}:${shapeOf(child, depth + 1)}`)
      .sort();
    return `{${entries.join(",")}}`;
  }
  return typeof value;
}

/** Equal, or equal once a wildcard from an empty collection is allowed to match. */
export function compatible(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.includes("?") && !b.includes("?")) return false;
  const pattern = (source: string) =>
    new RegExp(`^${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\?/g, ".*")}$`);
  return pattern(a).test(b) || pattern(b).test(a);
}
