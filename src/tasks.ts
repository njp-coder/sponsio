import { summarize } from "./diff.js";
import { inverseOf } from "./reversibility.js";
import type { DiffResult, Finding, JsonSchema, Snapshot, ToolRecord } from "./types.js";

/**
 * One thing an agent must be able to do for a task to be possible.
 *
 * Deliberately structural. Whether a *model* picks the right tool is a
 * different, non-deterministic question that needs a real model and gives a
 * different answer on Tuesday; whether the surface can *express* the task at
 * all is answerable from the schemas, for free, the same way every time.
 */
export interface TaskNeed {
  /** A tool that must exist. Also scopes any `param` in the same need. */
  tool?: string;
  /** A parameter concept the surface must accept — matched on name and description. */
  param?: string;
  /** That parameter must be a number. */
  numeric?: boolean;
  /** That parameter must express a range, not just a value. */
  bounded?: boolean;
  /** That parameter's enum must still offer this value. */
  enumValue?: string;
  /** This tool must have something that undoes it. */
  reversible?: string;
}

export interface TaskSpec {
  name: string;
  needs: TaskNeed[];
}

/**
 * Can an agent express these journeys against the tools you expose?
 *
 * A contract diff tells you a value disappeared. This tells you which user
 * journey stopped being possible when it did — which is the sentence a
 * product owner can act on.
 */
export function auditTasks(snapshot: Snapshot, tasks: TaskSpec[]): DiffResult {
  const findings: Finding[] = [];

  for (const task of tasks) {
    const failures: string[] = [];

    for (const need of task.needs) {
      const failure = evaluate(snapshot, need);
      if (failure) failures.push(failure);
    }

    if (failures.length === 0) {
      findings.push({
        severity: "safe",
        code: "TASK_COVERED",
        tool: `«${task.name}»`,
        message: `Expressible against the current surface.`,
      });
      continue;
    }

    for (const failure of failures) {
      findings.push({
        severity: "breaking",
        code: "TASK_UNSUPPORTED",
        tool: `«${task.name}»`,
        message: failure,
      });
    }
  }

  return summarize(findings);
}

function evaluate(snapshot: Snapshot, need: TaskNeed): string | undefined {
  if (need.reversible) {
    const target = snapshot.tools.find((tool) => tool.name === need.reversible);
    if (!target) return `no \`${need.reversible}\` tool, so the journey cannot start.`;
    if (!inverseOf(snapshot, need.reversible)) {
      return `\`${need.reversible}\` has nothing that undoes it, so the journey is one-way.`;
    }
    return undefined;
  }

  const scoped = need.tool
    ? snapshot.tools.filter((tool) => tool.name === need.tool)
    : snapshot.tools;

  if (need.tool && scoped.length === 0) {
    return `no \`${need.tool}\` tool is registered.`;
  }

  if (!need.param) return undefined;

  const matches = scoped.flatMap((tool) =>
    parameters(tool).filter((entry) => mentions(entry, need.param!)),
  );

  if (matches.length === 0) {
    return need.tool
      ? `\`${need.tool}\` has no parameter for “${need.param}”.`
      : `no tool accepts a “${need.param}” parameter.`;
  }

  if (need.numeric && !matches.some((entry) => isNumeric(entry.schema))) {
    return `“${need.param}” exists but is not numeric, so it cannot carry a value to compare.`;
  }

  if (need.bounded && !matches.some((entry) => isBounded(entry))) {
    return `“${need.param}” accepts a value but not a range, so “under” or “over” cannot be expressed.`;
  }

  if (need.enumValue !== undefined) {
    const offered = matches.some(
      (entry) =>
        Array.isArray(entry.schema.enum) &&
        entry.schema.enum.some((value) => String(value) === need.enumValue),
    );
    if (!offered) {
      return `“${need.param}” no longer offers “${need.enumValue}”, so this journey silently returns nothing.`;
    }
  }

  return undefined;
}

interface Parameter {
  name: string;
  schema: JsonSchema;
}

function parameters(tool: ToolRecord, schema = tool.inputSchema, depth = 0): Parameter[] {
  if (!schema || depth > 6) return [];
  const out: Parameter[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    out.push({ name, schema: property });
    out.push(...parameters(tool, property, depth + 1));
  }
  return out;
}

/** Matches on the parameter's own name or its description, word-wise. */
function mentions(entry: Parameter, term: string): boolean {
  const needle = term.toLowerCase();
  const haystack = `${entry.name} ${entry.schema.description ?? ""}`
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .toLowerCase();
  return haystack.split(/\s+/).some((word) => word === needle || word.startsWith(needle));
}

function isNumeric(schema: JsonSchema): boolean {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  return type === "number" || type === "integer";
}

/**
 * A range can be declared two ways: as constraints on one parameter, or as a
 * pair of parameters whose names carry the direction (`max_price`, `price_to`).
 */
function isBounded(entry: Parameter): boolean {
  if (typeof entry.schema.minimum === "number" || typeof entry.schema.maximum === "number") {
    return true;
  }
  return RANGE_WORD.test(entry.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "));
}

const RANGE_WORD = /\b(min|max|minimum|maximum|from|to|under|over|below|above|before|after|since|until|lte|gte)\b/i;
