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

function compareSchema(
  before: JsonSchema,
  after: JsonSchema,
  tool: string,
  path: string,
  findings: Finding[],
): void {
  const at = path || "(root)";

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
    compareSchema(beforeProp, afterProp, tool, childPath, findings);
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

  if (before.items && after.items) {
    compareSchema(before.items, after.items, tool, join(path, "[]"), findings);
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

export function summarize(findings: Finding[]): DiffResult {
  const counts: Record<Severity, number> = { breaking: 0, warning: 0, safe: 0 };
  for (const finding of findings) counts[finding.severity]++;
  const order: Record<Severity, number> = { breaking: 0, warning: 1, safe: 2 };
  const sorted = [...findings].sort(
    (a, b) => order[a.severity] - order[b.severity] || a.tool.localeCompare(b.tool),
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
