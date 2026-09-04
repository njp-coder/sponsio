import type {
  DiffResult,
  Finding,
  JsonSchema,
  Severity,
  Snapshot,
  ToolAnnotations,
  ToolRecord,
} from "./types.js";

/**
 * Compare two snapshots and classify every change by what it does to an agent
 * that was already calling these tools.
 *
 * The severity model is the whole point:
 *   breaking — a call that worked before will now fail or do the wrong thing
 *   warning  — the call still succeeds, but the agent's behavior may change
 *   safe     — strictly more capability, nothing an existing caller relied on
 *
 * Description changes land in `warning`, not `safe`. For an LLM agent the
 * description is not documentation, it is the selection interface: reword it and
 * the model may stop choosing the tool, with every schema still identical.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): DiffResult {
  const findings: Finding[] = [];
  const beforeTools = new Map(before.tools.map((t) => [t.name, t]));
  const afterTools = new Map(after.tools.map((t) => [t.name, t]));

  for (const [name, beforeTool] of beforeTools) {
    const afterTool = afterTools.get(name);
    if (!afterTool) {
      findings.push({
        severity: "breaking",
        code: "TOOL_REMOVED",
        tool: name,
        message: `Tool \`${name}\` is gone. Agents that call it will fail.`,
      });
      continue;
    }
    compareTool(beforeTool, afterTool, findings);
  }

  for (const [name, afterTool] of afterTools) {
    if (beforeTools.has(name)) continue;
    findings.push({
      severity: "safe",
      code: "TOOL_ADDED",
      tool: name,
      message: `New tool \`${name}\`${
        afterTool.annotations?.consequential ? " (marked consequential)" : ""
      }.`,
    });
  }

  return summarize(findings);
}

function compareTool(before: ToolRecord, after: ToolRecord, findings: Finding[]): void {
  const tool = after.name;

  if (before.description !== after.description) {
    findings.push({
      severity: "warning",
      code: "DESCRIPTION_CHANGED",
      tool,
      message:
        `Description changed. The model selects tools by description, so this can ` +
        `change behavior with no schema change.`,
    });
  }

  if (before.kind !== after.kind) {
    findings.push({
      severity: "warning",
      code: "KIND_CHANGED",
      tool,
      message: `Registration changed from ${before.kind} to ${after.kind}.`,
    });
  }

  compareAnnotations(before.annotations, after.annotations, tool, findings);

  const hadSchema = before.inputSchema !== undefined;
  const hasSchema = after.inputSchema !== undefined;

  if (hadSchema && !hasSchema) {
    findings.push({
      severity: "warning",
      code: "SCHEMA_REMOVED",
      tool,
      message: `No longer declares an inputSchema; arguments are now unvalidated.`,
    });
  } else if (!hadSchema && hasSchema) {
    findings.push({
      severity: "warning",
      code: "SCHEMA_ADDED",
      tool,
      message: `Now declares an inputSchema; previously-accepted arguments may be rejected.`,
    });
  } else if (before.inputSchema && after.inputSchema) {
    compareSchema(before.inputSchema, after.inputSchema, tool, "", findings);
  }
}

/**
 * Safety hints are part of the contract too. Losing `readOnly` means a tool an
 * agent was free to call speculatively can now change the world.
 */
function compareAnnotations(
  before: ToolAnnotations | undefined,
  after: ToolAnnotations | undefined,
  tool: string,
  findings: Finding[],
): void {
  const b = before ?? {};
  const a = after ?? {};

  if (b.readOnly === true && a.readOnly !== true) {
    findings.push({
      severity: "breaking",
      code: "READONLY_REMOVED",
      tool,
      message: `Lost its readOnly hint — this tool now has side effects.`,
    });
  }
  if (b.readOnly !== true && a.readOnly === true) {
    findings.push({
      severity: "safe",
      code: "READONLY_ADDED",
      tool,
      message: `Now declares readOnly.`,
    });
  }
  if (b.consequential === true && a.consequential !== true) {
    findings.push({
      severity: "breaking",
      code: "CONSEQUENTIAL_REMOVED",
      tool,
      message: `Lost its consequential hint — approval gates keyed on it will stop firing.`,
    });
  }
  if (b.consequential !== true && a.consequential === true) {
    findings.push({
      severity: "warning",
      code: "CONSEQUENTIAL_ADDED",
      tool,
      message: `Now marked consequential — agents may require approval before calling it.`,
    });
  }
  if (b.untrustedContent !== true && a.untrustedContent === true) {
    findings.push({
      severity: "warning",
      code: "UNTRUSTED_CONTENT_ADDED",
      tool,
      message: `Output is now flagged as untrusted content.`,
    });
  }
}

/** Carries the two root schemas so `$ref` can be resolved, plus loop protection. */
interface SchemaContext {
  beforeRoot: JsonSchema;
  afterRoot: JsonSchema;
  depth: number;
  seen: Set<string>;
}

const MAX_DEPTH = 16;

function compareSchema(
  beforeRaw: JsonSchema,
  afterRaw: JsonSchema,
  tool: string,
  path: string,
  findings: Finding[],
  context?: SchemaContext,
): void {
  const at = path || "(root)";
  const ctx: SchemaContext = context ?? {
    beforeRoot: beforeRaw,
    afterRoot: afterRaw,
    depth: 0,
    seen: new Set(),
  };

  if (ctx.depth > MAX_DEPTH) return;

  // A pair of $refs can point back at each other; visiting a pair twice means
  // the structures recurse and there is nothing further to learn.
  const refKey = `${String(beforeRaw.$ref ?? "")}|${String(afterRaw.$ref ?? "")}`;
  if (refKey !== "|") {
    if (ctx.seen.has(refKey)) return;
    ctx.seen.add(refKey);
  }

  const before = resolveRef(beforeRaw, ctx.beforeRoot);
  const after = resolveRef(afterRaw, ctx.afterRoot);
  const next: SchemaContext = { ...ctx, depth: ctx.depth + 1 };

  compareConst(before, after, tool, at, findings);
  compareAdditionalProperties(before, after, tool, at, findings);
  compareCombinators(before, after, tool, path, findings, next);

  const beforeType = normalizeType(before.type);
  const afterType = normalizeType(after.type);
  if (beforeType && afterType && beforeType !== afterType) {
    findings.push({
      severity: "breaking",
      code: "TYPE_CHANGED",
      tool,
      path: at,
      message: `Type changed from ${beforeType} to ${afterType}.`,
    });
  }

  compareEnum(before, after, tool, at, findings);
  compareConstraints(before, after, tool, at, findings);

  if (
    path &&
    before.description !== undefined &&
    after.description !== undefined &&
    before.description !== after.description
  ) {
    findings.push({
      severity: "warning",
      code: "PARAM_DESCRIPTION_CHANGED",
      tool,
      path: at,
      message: `Parameter description changed; the model may fill it differently.`,
    });
  }

  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  const beforeRequired = new Set(before.required ?? []);
  const afterRequired = new Set(after.required ?? []);

  for (const [key, beforeProp] of Object.entries(beforeProps)) {
    const childPath = join(path, key);
    const afterProp = afterProps[key];
    if (!afterProp) {
      findings.push({
        severity: beforeRequired.has(key) ? "breaking" : "warning",
        code: "PROPERTY_REMOVED",
        tool,
        path: childPath,
        message: beforeRequired.has(key)
          ? `Required property removed; calls built against the old schema break.`
          : `Optional property removed; agents still sending it may be rejected.`,
      });
      continue;
    }
    if (!beforeRequired.has(key) && afterRequired.has(key)) {
      findings.push({
        severity: "breaking",
        code: "REQUIRED_ADDED",
        tool,
        path: childPath,
        message: `Now required. Agents that omit it will fail.`,
      });
    }
    if (beforeRequired.has(key) && !afterRequired.has(key)) {
      findings.push({
        severity: "safe",
        code: "REQUIRED_REMOVED",
        tool,
        path: childPath,
        message: `No longer required.`,
      });
    }
    compareSchema(beforeProp, afterProp, tool, childPath, findings, next);
  }

  for (const key of Object.keys(afterProps)) {
    if (key in beforeProps) continue;
    const childPath = join(path, key);
    if (afterRequired.has(key)) {
      findings.push({
        severity: "breaking",
        code: "REQUIRED_ADDED",
        tool,
        path: childPath,
        message: `New required property. Agents that omit it will fail.`,
      });
    } else {
      findings.push({
        severity: "safe",
        code: "PROPERTY_ADDED",
        tool,
        path: childPath,
        message: `New optional property.`,
      });
    }
  }

  compareItems(before, after, tool, path, findings, next);
}

/**
 * Arrays come in two shapes: a single schema every element must match, or a
 * positional tuple (`prefixItems` in 2020-12, an array-valued `items` before
 * that). Losing a tuple position rejects input that used to be accepted.
 */
function compareItems(
  before: JsonSchema,
  after: JsonSchema,
  tool: string,
  path: string,
  findings: Finding[],
  ctx: SchemaContext,
): void {
  const beforeTuple = tupleOf(before);
  const afterTuple = tupleOf(after);

  if (beforeTuple && afterTuple) {
    const shared = Math.min(beforeTuple.length, afterTuple.length);
    for (let index = 0; index < shared; index++) {
      compareSchema(
        beforeTuple[index]!,
        afterTuple[index]!,
        tool,
        join(path, `[${index}]`),
        findings,
        ctx,
      );
    }
    if (afterTuple.length < beforeTuple.length) {
      findings.push({
        severity: "breaking",
        code: "TUPLE_SHORTENED",
        tool,
        path: path || "(root)",
        message: `Tuple went from ${beforeTuple.length} to ${afterTuple.length} positions.`,
      });
    } else if (afterTuple.length > beforeTuple.length) {
      findings.push({
        severity: "safe",
        code: "TUPLE_EXTENDED",
        tool,
        path: path || "(root)",
        message: `Tuple gained ${afterTuple.length - beforeTuple.length} position(s).`,
      });
    }
    return;
  }

  const beforeItems = singleItemSchema(before);
  const afterItems = singleItemSchema(after);
  if (beforeItems && afterItems) {
    compareSchema(beforeItems, afterItems, tool, join(path, "[]"), findings, ctx);
  }
}

function tupleOf(schema: JsonSchema): JsonSchema[] | undefined {
  if (Array.isArray(schema["prefixItems"])) return schema["prefixItems"] as JsonSchema[];
  if (Array.isArray(schema.items)) return schema.items as unknown as JsonSchema[];
  return undefined;
}

function singleItemSchema(schema: JsonSchema): JsonSchema | undefined {
  return schema.items && !Array.isArray(schema.items) ? schema.items : undefined;
}

/** Resolves a local `#/...` pointer. Remote refs are left alone. */
function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#")) return schema;

  const segments = ref
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return schema;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "object" && current !== null ? (current as JsonSchema) : schema;
}

function compareConst(
  before: JsonSchema,
  after: JsonSchema,
  tool: string,
  path: string,
  findings: Finding[],
): void {
  const b = before["const"];
  const a = after["const"];
  if (b === undefined && a === undefined) return;
  if (JSON.stringify(b) === JSON.stringify(a)) return;

  if (a === undefined) {
    findings.push({
      severity: "safe",
      code: "CONST_REMOVED",
      tool,
      path,
      message: `Fixed value constraint removed.`,
    });
  } else {
    findings.push({
      severity: "breaking",
      code: b === undefined ? "CONST_ADDED" : "CONST_CHANGED",
      tool,
      path,
      message:
        b === undefined
          ? `Now pinned to ${render(a)}; any other value is rejected.`
          : `Fixed value changed from ${render(b)} to ${render(a)}.`,
    });
  }
}

function compareAdditionalProperties(
  before: JsonSchema,
  after: JsonSchema,
  tool: string,
  path: string,
  findings: Finding[],
): void {
  // Absent means permitted, so only an explicit `false` closes the object.
  const wasClosed = before.additionalProperties === false;
  const isClosed = after.additionalProperties === false;
  if (wasClosed === isClosed) return;

  findings.push(
    isClosed
      ? {
          severity: "breaking",
          code: "ADDITIONAL_PROPERTIES_CLOSED",
          tool,
          path,
          message: `Extra properties are now rejected; agents sending any will fail.`,
        }
      : {
          severity: "safe",
          code: "ADDITIONAL_PROPERTIES_OPENED",
          tool,
          path,
          message: `Extra properties are now accepted.`,
        },
  );
}

type Combinator = "oneOf" | "anyOf" | "allOf";
const COMBINATORS: Combinator[] = ["oneOf", "anyOf", "allOf"];

/**
 * For `oneOf`/`anyOf`, branches are alternatives: fewer of them accepts less.
 * For `allOf`, branches are conjoined requirements: more of them accepts less.
 */
function compareCombinators(
  before: JsonSchema,
  after: JsonSchema,
  tool: string,
  path: string,
  findings: Finding[],
  ctx: SchemaContext,
): void {
  for (const keyword of COMBINATORS) {
    const b = before[keyword];
    const a = after[keyword];
    if (!Array.isArray(b) && !Array.isArray(a)) continue;

    const beforeBranches = (Array.isArray(b) ? b : []) as JsonSchema[];
    const afterBranches = (Array.isArray(a) ? a : []) as JsonSchema[];
    const at = path || "(root)";

    const narrowsWhenFewer = keyword !== "allOf";
    const delta = afterBranches.length - beforeBranches.length;

    if (delta < 0) {
      findings.push({
        severity: narrowsWhenFewer ? "breaking" : "safe",
        code: "COMBINATOR_BRANCH_REMOVED",
        tool,
        path: at,
        message: narrowsWhenFewer
          ? `${keyword} lost ${-delta} alternative(s); input matching them is now rejected.`
          : `${keyword} dropped ${-delta} requirement(s).`,
      });
    } else if (delta > 0) {
      findings.push({
        severity: narrowsWhenFewer ? "safe" : "breaking",
        code: "COMBINATOR_BRANCH_ADDED",
        tool,
        path: at,
        message: narrowsWhenFewer
          ? `${keyword} gained ${delta} alternative(s).`
          : `${keyword} added ${delta} requirement(s); previously-valid input may now fail.`,
      });
    }

    const shared = Math.min(beforeBranches.length, afterBranches.length);
    for (let index = 0; index < shared; index++) {
      compareSchema(
        beforeBranches[index]!,
        afterBranches[index]!,
        tool,
        join(path, `${keyword}[${index}]`),
        findings,
        ctx,
      );
    }
  }
}

function compareEnum(
  before: JsonSchema,
  after: JsonSchema,
  tool: string,
  path: string,
  findings: Finding[],
): void {
  if (!Array.isArray(before.enum) || !Array.isArray(after.enum)) return;
  const afterSet = new Set(after.enum.map(stableKey));
  const beforeSet = new Set(before.enum.map(stableKey));

  const removed = before.enum.filter((v) => !afterSet.has(stableKey(v)));
  const added = after.enum.filter((v) => !beforeSet.has(stableKey(v)));

  if (removed.length) {
    findings.push({
      severity: "breaking",
      code: "ENUM_VALUE_REMOVED",
      tool,
      path,
      message: `Allowed values removed: ${removed.map(render).join(", ")}. ` +
        `A tool call using one of these now fails — often silently, as an empty result.`,
    });
  }
  if (added.length) {
    findings.push({
      severity: "safe",
      code: "ENUM_VALUE_ADDED",
      tool,
      path,
      message: `Allowed values added: ${added.map(render).join(", ")}.`,
    });
  }
}

interface ConstraintRule {
  key: "minimum" | "maximum" | "minLength" | "maxLength";
  /** True when moving from `before` to `after` accepts strictly fewer inputs. */
  narrows: (before: number, after: number) => boolean;
  label: string;
}

const NUMERIC_CONSTRAINTS: ConstraintRule[] = [
  { key: "minimum", narrows: (b, a) => a > b, label: "minimum" },
  { key: "maximum", narrows: (b, a) => a < b, label: "maximum" },
  { key: "minLength", narrows: (b, a) => a > b, label: "minLength" },
  { key: "maxLength", narrows: (b, a) => a < b, label: "maxLength" },
];

function compareConstraints(
  before: JsonSchema,
  after: JsonSchema,
  tool: string,
  path: string,
  findings: Finding[],
): void {
  for (const rule of NUMERIC_CONSTRAINTS) {
    const b = before[rule.key];
    const a = after[rule.key];
    if (typeof a !== "number") continue;

    if (typeof b !== "number") {
      findings.push({
        severity: "breaking",
        code: "CONSTRAINT_ADDED",
        tool,
        path,
        message: `New ${rule.label} of ${a}; previously-valid arguments may now be rejected.`,
      });
      continue;
    }
    if (rule.narrows(b, a)) {
      findings.push({
        severity: "breaking",
        code: "CONSTRAINT_NARROWED",
        tool,
        path,
        message: `${rule.label} tightened from ${b} to ${a}.`,
      });
    } else if (b !== a) {
      findings.push({
        severity: "safe",
        code: "CONSTRAINT_RELAXED",
        tool,
        path,
        message: `${rule.label} relaxed from ${b} to ${a}.`,
      });
    }
  }

  if (before.pattern !== after.pattern) {
    if (after.pattern !== undefined) {
      findings.push({
        severity: "breaking",
        code: before.pattern === undefined ? "CONSTRAINT_ADDED" : "CONSTRAINT_NARROWED",
        tool,
        path,
        message:
          before.pattern === undefined
            ? `New pattern \`${after.pattern}\`; previously-valid arguments may now be rejected.`
            : `Pattern changed from \`${before.pattern}\` to \`${after.pattern}\`.`,
      });
    } else {
      findings.push({
        severity: "safe",
        code: "CONSTRAINT_RELAXED",
        tool,
        path,
        message: `Pattern constraint removed.`,
      });
    }
  }
}

function normalizeType(type: string | string[] | undefined): string | undefined {
  if (type === undefined) return undefined;
  return Array.isArray(type) ? [...type].sort().join("|") : type;
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function stableKey(value: unknown): string {
  return typeof value === "string" ? `s:${value}` : `j:${JSON.stringify(value)}`;
}

function render(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

const SEVERITY_ORDER: Record<Severity, number> = { breaking: 0, warning: 1, safe: 2 };

/**
 * Group findings by tool, worst-affected tool first, and worst finding first
 * within each tool — so a reader sees every problem with one tool together,
 * and still meets the most serious tool at the top.
 */
export function summarize(findings: Finding[]): DiffResult {
  const counts: Record<Severity, number> = { breaking: 0, warning: 0, safe: 0 };
  const worstByTool = new Map<string, number>();

  for (const finding of findings) {
    counts[finding.severity]++;
    const rank = SEVERITY_ORDER[finding.severity];
    const current = worstByTool.get(finding.tool);
    if (current === undefined || rank < current) worstByTool.set(finding.tool, rank);
  }

  const sorted = [...findings].sort(
    (a, b) =>
      worstByTool.get(a.tool)! - worstByTool.get(b.tool)! ||
      a.tool.localeCompare(b.tool) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return { findings: sorted, counts, clean: findings.length === 0 };
}

export type FailOn = "breaking" | "warning" | "any" | "never";

export function shouldFail(result: DiffResult, failOn: FailOn): boolean {
  switch (failOn) {
    case "never":
      return false;
    case "breaking":
      return result.counts.breaking > 0;
    case "warning":
      return result.counts.breaking > 0 || result.counts.warning > 0;
    case "any":
      return !result.clean;
  }
}
