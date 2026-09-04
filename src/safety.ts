import { summarize } from "./diff.js";
import type { DiffResult, Finding, JsonSchema, Snapshot, ToolRecord } from "./types.js";
import { effectOf, isPropagating } from "./reversibility.js";

/**
 * Safety properties you can read straight off the tool surface, without
 * calling anything.
 *
 * Two of these exist because of how agents behave rather than how sites are
 * written: agents retry a failed write the same way they retry a read, and
 * agents will fill in whatever a schema asks them for. A tool that takes a
 * payment without an idempotency key will eventually be charged twice, and a
 * tool whose schema asks for a card number is asking a language model to
 * handle one.
 */
export function auditSafety(snapshot: Snapshot): DiffResult {
  const findings: Finding[] = [];

  for (const tool of snapshot.tools) {
    checkIdempotency(tool, findings);
    checkSensitiveParameters(tool, findings);
    checkPropagation(tool, findings);
  }

  return summarize(findings);
}

/**
 * An agent that times out mid-call cannot tell "the charge failed" from "the
 * response was lost". Without a caller-supplied key the site cannot tell either,
 * so the safe retry every agent framework performs becomes a second charge.
 */
function checkIdempotency(tool: ToolRecord, findings: Finding[]): void {
  const effect = effectOf(tool);
  if (effect !== "consequential") return;
  if (!tool.inputSchema) return;

  const hasKey = walk(tool.inputSchema).some(({ name }) => IDEMPOTENCY_KEY.test(name));
  if (hasKey) return;

  findings.push({
    severity: "breaking",
    code: "NO_IDEMPOTENCY_KEY",
    tool: tool.name,
    message:
      `Consequential action with no idempotency key in its schema. Agents retry ` +
      `failed writes the way they retry reads, so this will eventually run twice. ` +
      `Accept an \`idempotency_key\` and dedupe on it.`,
  });
}

const IDEMPOTENCY_KEY = /idempot|dedup|(^|_)nonce($|_)|request_?id|client_?token|client_?ref/i;

/**
 * Anything the schema asks for, the model will try to supply — from its context,
 * from the page, or by asking the user in chat. None of those are places card
 * numbers or passwords should travel.
 */
function checkSensitiveParameters(tool: ToolRecord, findings: Finding[]): void {
  if (!tool.inputSchema) return;

  for (const { path, name, schema } of walk(tool.inputSchema)) {
    const haystack = `${name} ${schema.description ?? ""}`;
    const category = SENSITIVE.find((entry) => entry.pattern.test(haystack));
    if (!category) continue;

    findings.push({
      severity: "breaking",
      code: "SENSITIVE_PARAMETER",
      tool: tool.name,
      path,
      message:
        `Schema asks the agent for ${category.label}. A model should never be ` +
        `handed this — ${category.remedy}`,
    });
  }
}

const SENSITIVE: { pattern: RegExp; label: string; remedy: string }[] = [
  {
    pattern: /(^|[_\s])(password|passwd|passphrase)([_\s]|$)|(^|[_\s])pin([_\s]|$)/i,
    label: "a password or PIN",
    remedy: "authenticate the session instead of passing credentials as arguments.",
  },
  {
    pattern: /card[_\s]?number|(^|[_\s])pan([_\s]|$)|(^|[_\s])(cvv|cvc)([_\s]|$)|security[_\s]?code/i,
    label: "raw card details",
    remedy: "take a payment token from a hosted field, never the number itself.",
  },
  {
    pattern: /(^|[_\s])ssn([_\s]|$)|social[_\s]?security|passport[_\s]?number|national[_\s]?id/i,
    label: "a government identity number",
    remedy: "collect it in your own UI, outside the agent's reach.",
  },
  {
    pattern: /seed[_\s]?phrase|mnemonic|private[_\s]?key|secret[_\s]?key|api[_\s]?key/i,
    label: "a secret key",
    remedy: "scope credentials to the session rather than accepting them as input.",
  },
  {
    pattern: /routing[_\s]?number|(bank|account)[_\s]?number|iban|sort[_\s]?code/i,
    label: "raw bank details",
    remedy: "use a stored payment method reference instead.",
  },
];

/**
 * Some actions have an inverse that does not actually undo them. A recalled
 * message may already have been read; a refunded charge still moved money and
 * left fees behind. Structural reversibility and effective reversibility are
 * different things, and only the first is visible in a schema.
 */
function checkPropagation(tool: ToolRecord, findings: Finding[]): void {
  if (effectOf(tool) === "read") return;
  if (!isPropagating(tool.name)) return;

  findings.push({
    severity: "warning",
    code: "EFFECT_ESCAPES",
    tool: tool.name,
    message:
      `The effect leaves your system the moment it runs. Even with an inverse ` +
      `tool, recipients may have already seen it or funds may have already moved — ` +
      `gate this behind confirmation rather than relying on undo.`,
  });
}

/** Every named property in a schema, including nested ones and array elements. */
function walk(
  schema: JsonSchema,
  path = "",
  depth = 0,
): { path: string; name: string; schema: JsonSchema }[] {
  if (depth > 8) return [];
  const out: { path: string; name: string; schema: JsonSchema }[] = [];

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const childPath = path ? `${path}.${name}` : name;
    out.push({ path: childPath, name, schema: property });
    out.push(...walk(property, childPath, depth + 1));
  }

  const items = schema.items && !Array.isArray(schema.items) ? schema.items : undefined;
  if (items) out.push(...walk(items, `${path}[]`, depth + 1));

  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    for (const branch of schema[keyword] ?? []) {
      out.push(...walk(branch, path, depth + 1));
    }
  }

  return out;
}
