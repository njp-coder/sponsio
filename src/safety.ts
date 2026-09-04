import { summarize } from "./diff.js";
import type { DiffResult, Finding, JsonSchema, Snapshot, ToolRecord } from "./types.js";
import { effectOf, isPropagating, parseName } from "./reversibility.js";

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

  checkRegistration(snapshot, findings);

  for (const tool of snapshot.tools) {
    checkIdempotency(tool, findings);
    checkSensitiveParameters(tool, findings);
    checkPropagation(tool, findings);
    checkBlastRadius(tool, findings);
    checkPrivilegeEscalation(tool, findings);
    checkDataEgress(tool, findings);
    checkCallerChosenSubject(tool, findings);
    checkLongRunning(tool, snapshot, findings);
  }

  return summarize(findings);
}

/**
 * The failure that costs the most and shows the least.
 *
 * If `document.modelContext` is absent — an origin-trial token that lapsed, a
 * flag that isn't set, a script that ran too early — then every
 * `registerTool()` call on the page throws nothing and does nothing. The site
 * looks fine to every human who visits, and exposes nothing to every agent.
 * One team shipped in that state for three months without noticing.
 */
function checkRegistration(snapshot: Snapshot, findings: Finding[]): void {
  if (snapshot.apiAvailable === false) {
    findings.push({
      severity: "breaking",
      code: "API_UNAVAILABLE",
      tool: "(page)",
      message:
        `\`document.modelContext\` does not exist on this page, so every ` +
        `registerTool() call is a silent no-op and agents see nothing. Usually a ` +
        `lapsed origin-trial token, or the meta tag missing on this route.`,
    });
    return;
  }

  if (snapshot.tools.length === 0) {
    findings.push({
      severity: "breaking",
      code: "NO_TOOLS_REGISTERED",
      tool: "(page)",
      message:
        `The API is available but nothing registered. If this page is meant to ` +
        `expose tools, registration failed or ran after the page settled.`,
    });
  }
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

/**
 * A quantity with no ceiling is an unbounded blast radius.
 *
 * The most-read agent incident of 2026 was an operator waking to a $6,531 cloud
 * bill after an agent looped on an error. A `maximum` in the schema is the one
 * place a site can cap what a single call is allowed to cost, and it also tells
 * the model what a sane value looks like.
 */
function checkBlastRadius(tool: ToolRecord, findings: Finding[]): void {
  if (effectOf(tool) === "read") return;
  if (!tool.inputSchema) return;

  for (const { path, name, schema } of walk(tool.inputSchema)) {
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (type !== "number" && type !== "integer") continue;
    if (typeof schema.maximum === "number") continue;
    if (!MAGNITUDE.test(name)) continue;

    findings.push({
      severity: "warning",
      code: "UNBOUNDED_MAGNITUDE",
      tool: tool.name,
      path,
      message:
        `\`${name}\` has no maximum, so a single call has no ceiling. Declare one — ` +
        `it caps the damage from a miscalculation and tells the model what is reasonable.`,
    });
  }
}

const MAGNITUDE =
  /amount|price|total|cost|fee|quantity|qty|count|limit|size|duration|units|balance|value/i;

/**
 * Tools that hand out access are the ones an agent should never call
 * unsupervised — a compromised or confused agent that can grant itself
 * permissions turns a mistake into a persistent foothold.
 */
function checkPrivilegeEscalation(tool: ToolRecord, findings: Finding[]): void {
  if (effectOf(tool) === "read") return;
  // Underscore is a word character, so `\bgrant\b` would miss `grant_role`.
  const haystack = `${tool.name} ${tool.description}`.replace(/[_-]/g, " ");
  if (!PRIVILEGE.test(haystack)) return;

  findings.push({
    severity: tool.annotations?.consequential === true ? "warning" : "breaking",
    code: "GRANTS_ACCESS",
    tool: tool.name,
    message:
      tool.annotations?.consequential === true
        ? `Grants access or credentials. Confirm your approval gate covers it — ` +
          `an agent that can widen its own permissions can make a mistake permanent.`
        : `Grants access or credentials but is not marked consequential, so agents ` +
          `will call it without asking. Mark it, or move it out of the agent surface.`,
  });
}

const PRIVILEGE =
  /\b(grant|revoke|permission|role|api[_\s]?key|token|credential|invite[_\s]?admin|add[_\s]?member|access[_\s]?control|scope|webhook)\b/i;

/**
 * Read-only is not the same as harmless.
 *
 * A tool that reads is safe to retry and safe to undo, which is why the
 * reversibility audit skips it — but `export_all_customers` is read-only and
 * catastrophic. Bulk reads are the exfiltration surface of an agent-facing site,
 * and an unbounded page size is what turns one call into the whole database.
 */
function checkDataEgress(tool: ToolRecord, findings: Finding[]): void {
  if (!BULK_READ.test(tool.name.replace(/[_-]/g, " "))) return;

  const properties = tool.inputSchema ? walk(tool.inputSchema) : [];
  const pager = properties.find(({ name }) => PAGE_SIZE.test(name));
  const bounded = pager && typeof pager.schema.maximum === "number";
  if (bounded) return;

  findings.push({
    severity: "warning",
    code: "UNBOUNDED_DATA_EGRESS",
    tool: tool.name,
    ...(pager ? { path: pager.path } : {}),
    message: pager
      ? `Bulk read whose \`${pager.name}\` has no maximum, so one call can return ` +
        `everything. Cap it — read-only does not mean harmless at volume.`
      : `Bulk read with no page-size parameter, so an agent cannot ask for less ` +
        `than everything. Add a bounded \`limit\`.`,
  });
}

const BULK_READ = /\b(export|download|dump|list|all|bulk|batch|search|query|fetch|scrape|extract)\b/i;
const PAGE_SIZE = /^(limit|page[_\s]?size|per[_\s]?page|count|max[_\s]?results|top|first|take)$/i;

/**
 * When the caller supplies the subject, the caller chooses the victim.
 *
 * A tool taking `user_id` as an argument lets the agent name whose record it
 * touches, and a model that has been prompt-injected or has simply confused two
 * customers will happily pass the wrong one. Derive the subject from the
 * authenticated session instead.
 */
function checkCallerChosenSubject(tool: ToolRecord, findings: Finding[]): void {
  if (!tool.inputSchema) return;

  for (const { path, name } of walk(tool.inputSchema)) {
    if (!SUBJECT_ID.test(name)) continue;

    const mutating = effectOf(tool) !== "read";
    findings.push({
      severity: mutating ? "breaking" : "warning",
      code: "CALLER_CHOSEN_SUBJECT",
      tool: tool.name,
      path,
      message:
        `The agent picks whose record this touches by passing \`${name}\`. ` +
        `Derive it from the authenticated session — a confused or injected model ` +
        `will pass someone else's.`,
    });
    return;
  }
}

const SUBJECT_ID =
  /^(user|customer|account|member|owner|org|organisation|organization|tenant|patient|client)[_-]?id$/i;

/**
 * If a tool starts work rather than finishing it, an agent needs a way to learn
 * how it went and a way to call it off.
 *
 * This is the shape of every site that offers a *service* rather than a
 * transaction — rendering, analysis, tutoring, data processing. Without a
 * companion status or cancel tool the agent has started something it can
 * neither observe nor stop, and its only recourse is to call it again.
 */
function checkLongRunning(tool: ToolRecord, snapshot: Snapshot, findings: Finding[]): void {
  const parsed = parseName(tool.name);
  if (!ASYNC_VERBS.has(parsed.verb)) return;

  const companions = snapshot.tools.filter((other) => other.name !== tool.name);
  const hasObserver = companions.some((other) => {
    const candidate = parseName(other.name);
    return (
      (OBSERVE_VERBS.has(candidate.verb) || OBSERVE_OBJECTS.test(other.name)) &&
      sharesSubject(candidate.object, parsed.object)
    );
  });
  const hasCancel = companions.some((other) => {
    const candidate = parseName(other.name);
    return CANCEL_VERBS.has(candidate.verb) && sharesSubject(candidate.object, parsed.object);
  });

  if (hasObserver && hasCancel) return;

  const missing = [!hasObserver ? "check progress" : null, !hasCancel ? "cancel it" : null]
    .filter(Boolean)
    .join(" or ");

  findings.push({
    severity: "warning",
    code: "UNOBSERVABLE_WORK",
    tool: tool.name,
    message:
      `Starts work an agent cannot ${missing}. Long-running tools need a status ` +
      `and a cancel counterpart, or the agent's only recourse when it hears ` +
      `nothing back is to call this again.`,
  });
}

const ASYNC_VERBS = new Set([
  "generate", "render", "process", "train", "analyze", "analyse", "compile",
  "build", "transcribe", "translate", "convert", "import", "sync", "index",
  "crawl", "scan", "compute", "simulate", "evaluate", "summarize", "summarise",
]);
const OBSERVE_VERBS = new Set(["get", "check", "poll", "status", "watch", "read", "fetch"]);
const CANCEL_VERBS = new Set(["cancel", "abort", "stop", "kill", "terminate"]);
const OBSERVE_OBJECTS = /\b(status|progress|state|result|job)\b/i;

/**
 * Two tools refer to the same work if either object contains the other, or if
 * one of them is generic — `get_job_status` covers every job on the page.
 */
function sharesSubject(a: string, b: string): boolean {
  if (a === b) return true;
  if (a !== "" && b !== "" && (a.includes(b) || b.includes(a))) return true;
  // Underscore is a word character, so \bjob\b would miss `job_status`.
  return /\b(job|task|run|request|operation)\b/.test(a.replace(/[_-]/g, " "));
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
