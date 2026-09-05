import { summarize } from "./diff.js";
import type { DiffResult, Finding, JsonSchema, Snapshot, ToolRecord } from "./types.js";

/**
 * Properties of the tool surface as a whole, rather than of any one tool.
 *
 * Every registered tool's name, description and schema is serialized into the
 * model's context on every turn, before any work happens — measured on MCP,
 * four servers consumed over 10% of a context window on definitions alone. And
 * tool-selection accuracy falls sharply as the number of choices grows. So a
 * site can make agents worse at using it simply by offering too much, too
 * verbosely, or too ambiguously.
 */
export function auditSurface(snapshot: Snapshot): DiffResult {
  const findings: Finding[] = [];
  if (snapshot.tools.length === 0) return summarize(findings);

  checkContextWeight(snapshot, findings);
  checkToolCount(snapshot, findings);
  checkDescriptions(snapshot, findings);
  checkDuplicateNames(snapshot, findings);
  checkParameterTypes(snapshot, findings);

  return summarize(findings);
}

/** Rough but standard: about four characters per token for English and JSON. */
export function estimateTokens(tools: ToolRecord[]): number {
  const serialized = tools
    .map((tool) =>
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? {},
        annotations: tool.annotations ?? {},
      }),
    )
    .join("");
  return Math.ceil(serialized.length / 4);
}

const HEAVY_TOKENS = 2000;
const VERY_HEAVY_TOKENS = 8000;

function checkContextWeight(snapshot: Snapshot, findings: Finding[]): void {
  const tokens = estimateTokens(snapshot.tools);
  if (tokens < HEAVY_TOKENS) return;

  findings.push({
    severity: tokens >= VERY_HEAVY_TOKENS ? "breaking" : "warning",
    code: "HEAVY_CONTEXT",
    tool: "(page)",
    message:
      `The tool surface costs roughly ${tokens.toLocaleString()} tokens of the agent's ` +
      `context on every turn, before it does anything. That budget comes out of the ` +
      `same window as the user's actual task — trim descriptions and schemas, or ` +
      `expose fewer tools per page.`,
  });
}

/** Past a certain number of choices the model stops picking well, regardless of quality. */
const CROWDED = 20;

function checkToolCount(snapshot: Snapshot, findings: Finding[]): void {
  if (snapshot.tools.length <= CROWDED) return;

  findings.push({
    severity: "warning",
    code: "TOO_MANY_TOOLS",
    tool: "(page)",
    message:
      `${snapshot.tools.length} tools on one page. Tool-selection accuracy degrades ` +
      `sharply as the count grows, so past roughly ${CROWDED} the model starts ` +
      `choosing wrong even when every tool is well written.`,
  });
}

function checkDescriptions(snapshot: Snapshot, findings: Finding[]): void {
  for (const tool of snapshot.tools) {
    const description = tool.description.trim();
    if (description.length === 0) {
      findings.push({
        severity: "breaking",
        code: "MISSING_DESCRIPTION",
        tool: tool.name,
        message: `No description. The model selects tools by description, so this one is a guess.`,
      });
    } else if (description.split(/\s+/).length < 3) {
      findings.push({
        severity: "warning",
        code: "VAGUE_DESCRIPTION",
        tool: tool.name,
        message:
          `Description is ${description.split(/\s+/).length} word(s). Say what it does ` +
          `and when not to use it — that is the whole basis for the model's choice.`,
      });
    }
  }

  // Near-identical descriptions are the other half of the selection problem: the
  // model has to choose between them and has nothing to choose on.
  const tools = snapshot.tools;
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const a = tools[i]!;
      const b = tools[j]!;
      const score = similarity(a.description, b.description);
      if (score < 0.7) continue;

      findings.push({
        severity: "warning",
        code: "AMBIGUOUS_DESCRIPTIONS",
        tool: a.name,
        message:
          `Description is ${Math.round(score * 100)}% the same as \`${b.name}\`. ` +
          `The model has to choose between them on this text alone, so say plainly ` +
          `what makes each the wrong choice.`,
      });
    }
  }
}

/**
 * Two tools registered under one name means the agent's choice is decided by
 * registration order rather than by anything it can see.
 */
function checkDuplicateNames(snapshot: Snapshot, findings: Finding[]): void {
  const seen = new Map<string, number>();
  for (const tool of snapshot.tools) {
    seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
  }
  for (const [name, count] of seen) {
    if (count < 2) continue;
    findings.push({
      severity: "breaking",
      code: "DUPLICATE_TOOL_NAME",
      tool: name,
      message:
        `Registered ${count} times. Which one an agent reaches depends on ` +
        `registration order, so behaviour changes with load timing.`,
    });
  }
}

/**
 * A parameter with no declared type tells the model nothing about what to put
 * there, so it guesses — and guesses differently between runs.
 */
function checkParameterTypes(snapshot: Snapshot, findings: Finding[]): void {
  for (const tool of snapshot.tools) {
    if (!tool.inputSchema) continue;
    for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
      if (describesAType(property)) continue;
      findings.push({
        severity: "warning",
        code: "UNTYPED_PARAMETER",
        tool: tool.name,
        path: name,
        message: `No declared type, so the model has to guess what belongs here.`,
      });
    }
  }
}

function describesAType(schema: JsonSchema): boolean {
  return (
    schema.type !== undefined ||
    schema.enum !== undefined ||
    schema["const"] !== undefined ||
    schema.$ref !== undefined ||
    schema.oneOf !== undefined ||
    schema.anyOf !== undefined ||
    schema.allOf !== undefined
  );
}

/** Jaccard overlap of meaningful words — cheap, and enough to catch copy-paste. */
export function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "by", "with",
  "this", "that", "it", "is", "are", "be", "from", "as", "at",
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}
