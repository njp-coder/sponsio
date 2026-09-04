import { summarize } from "./diff.js";
import type { LiveTool } from "./capture.js";
import type { DiffResult, Finding, JsonSchema } from "./types.js";

export interface ProbeOptions {
  /** Probe tools that are not declared readOnly. Off by default: probing calls them for real. */
  includeUnsafe?: boolean;
  /** Cap on probes per tool, so a wide schema can't run for minutes. */
  maxProbesPerTool?: number;
}

/**
 * Check whether each tool enforces the schema it publishes.
 *
 * The browser treats `inputSchema` as advisory — it is passed to the agent as
 * guidance, not validated on the way in. An independent scan found 78% of
 * probes were accepted despite violating the tool's own declared schema, on
 * Google's own reference demos. So a contract test that only reads the
 * declaration is testing a document, not a system.
 *
 * Probing *invokes* tools, so anything not declared readOnly is skipped unless
 * the caller opts in explicitly.
 */
export async function probeConformance(
  tools: LiveTool[],
  options: ProbeOptions = {},
): Promise<DiffResult> {
  const findings: Finding[] = [];
  const maxProbes = options.maxProbesPerTool ?? 8;

  for (const tool of tools) {
    if (!tool.inputSchema) continue;

    if (!isSafeToProbe(tool) && !options.includeUnsafe) {
      findings.push({
        severity: "safe",
        code: "PROBE_SKIPPED",
        tool: tool.name,
        message: `Skipped: not declared readOnly. Re-run with --probe-unsafe to include it.`,
      });
      continue;
    }

    const violations = buildViolations(tool.inputSchema).slice(0, maxProbes);
    for (const violation of violations) {
      const result = await tool.execute(violation.input);
      if (result.status === "Completed") {
        findings.push({
          severity: "warning",
          code: "SCHEMA_NOT_ENFORCED",
          tool: tool.name,
          path: violation.path,
          message: `Accepted ${violation.description}, which its own schema forbids.`,
        });
      }
    }
  }

  return summarize(findings);
}

function isSafeToProbe(tool: LiveTool): boolean {
  return tool.annotations?.readOnly === true && tool.annotations?.consequential !== true;
}

interface Violation {
  path: string;
  description: string;
  input: Record<string, unknown>;
}

/**
 * Each violation breaks exactly one rule, starting from an otherwise valid
 * payload — so an acceptance points at one specific unenforced keyword.
 */
export function buildViolations(schema: JsonSchema): Violation[] {
  const violations: Violation[] = [];
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const base = buildValidInput(schema);

  for (const name of required) {
    const { [name]: _omitted, ...withoutIt } = base;
    violations.push({
      path: name,
      description: `a call with required \`${name}\` missing`,
      input: withoutIt,
    });
  }

  for (const [name, property] of Object.entries(properties)) {
    const declared = typeOf(property);

    if (declared && declared !== "object" && declared !== "array") {
      violations.push({
        path: name,
        description: `\`${name}\` as ${declared === "string" ? "a number" : "a string"}`,
        input: { ...base, [name]: declared === "string" ? 42 : "not-a-number" },
      });
    }

    if (Array.isArray(property.enum) && property.enum.length > 0) {
      violations.push({
        path: name,
        description: `\`${name}\` set to a value outside its enum`,
        input: { ...base, [name]: "__sponsio_not_in_enum__" },
      });
    }

    if (typeof property.maximum === "number") {
      violations.push({
        path: name,
        description: `\`${name}\` above its maximum of ${property.maximum}`,
        input: { ...base, [name]: property.maximum + 1000 },
      });
    }

    if (typeof property.minimum === "number") {
      violations.push({
        path: name,
        description: `\`${name}\` below its minimum of ${property.minimum}`,
        input: { ...base, [name]: property.minimum - 1000 },
      });
    }

    if (typeof property.maxLength === "number") {
      violations.push({
        path: name,
        description: `\`${name}\` longer than its maxLength of ${property.maxLength}`,
        input: { ...base, [name]: "x".repeat(property.maxLength + 10) },
      });
    }

    if (typeof property.pattern === "string") {
      violations.push({
        path: name,
        description: `\`${name}\` violating its pattern`,
        input: { ...base, [name]: "__sponsio_pattern_violation__" },
      });
    }
  }

  return violations;
}

/** A minimal payload that satisfies the schema, used as the base for each probe. */
export function buildValidInput(schema: JsonSchema): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    const property = properties[name];
    if (property) input[name] = sampleValue(property);
  }
  return input;
}

function sampleValue(schema: JsonSchema): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema["const"] !== undefined) return schema["const"];

  switch (typeOf(schema)) {
    case "number":
    case "integer":
      return clampToRange(schema);
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return buildValidInput(schema);
    default:
      return "sponsio";
  }
}

function clampToRange(schema: JsonSchema): number {
  const min = typeof schema.minimum === "number" ? schema.minimum : 1;
  const max = typeof schema.maximum === "number" ? schema.maximum : min + 1;
  return Math.min(Math.max(1, min), max);
}

function typeOf(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type[0] : schema.type;
}
