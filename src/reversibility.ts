import { summarize } from "./diff.js";
import type { DiffResult, Finding, Snapshot, ToolRecord } from "./types.js";

/**
 * Does every action an agent can take here have a way back?
 *
 * A scan of live WebMCP deployments found that 97% of sites letting an agent
 * commit a purchase exposed no cancel, refund, or undo tool. An agent that can
 * act but cannot retract is a one-way door for the person who trusted it, so
 * this audits the tool surface for exactly that shape.
 */
export function auditReversibility(snapshot: Snapshot): DiffResult {
  const findings: Finding[] = [];
  const names = snapshot.tools.map((tool) => parseName(tool.name));

  for (const [index, tool] of snapshot.tools.entries()) {
    const parsed = names[index]!;
    const effect = classify(tool, parsed);
    if (effect === "read") continue;

    const inverse = findInverse(parsed, names, snapshot.tools, index);

    if (inverse) {
      findings.push({
        severity: "safe",
        code: "INVERSE_FOUND",
        tool: tool.name,
        message: `Reversible via \`${inverse}\`.`,
      });
    } else {
      findings.push({
        severity: effect === "consequential" ? "breaking" : "warning",
        code: "NO_INVERSE",
        tool: tool.name,
        message:
          effect === "consequential"
            ? `Consequential action with no inverse. An agent can commit this and has ` +
              `no tool to undo it. Expose ${suggest(parsed)}.`
            : `Changes state with no inverse tool. Consider exposing ${suggest(parsed)}.`,
      });
    }

    if (effect === "inferred" && tool.annotations?.consequential !== true) {
      findings.push({
        severity: "warning",
        code: "UNDECLARED_CONSEQUENCE",
        tool: tool.name,
        message:
          `Looks state-changing but declares no consequential hint, so agents ` +
          `will not gate it behind approval.`,
      });
    }
  }

  return summarize(findings);
}

export type Effect = "read" | "consequential" | "inferred";

/** Classify a tool's effect from its annotations and name alone. */
export function effectOf(tool: ToolRecord): Effect {
  return classify(tool, parseName(tool.name));
}

/**
 * Verbs whose effect leaves your system immediately — a message is delivered,
 * a post is public, money has moved. An inverse may exist, but it compensates
 * rather than undoes.
 */
const PROPAGATING_VERBS = new Set([
  "send", "email", "post", "publish", "share", "broadcast", "notify", "invite",
  "pay", "charge", "capture", "transfer", "submit", "deploy",
]);

export function isPropagating(toolName: string): boolean {
  return PROPAGATING_VERBS.has(parseName(toolName).verb);
}

/**
 * Annotations win when present; otherwise the verb is the only evidence
 * available, and an unannotated `delete_account` should not be treated as a read.
 *
 * The object matters as much as the verb. Cancelling an *order* moves money and
 * fulfilment; cancelling a *cart* discards a selection the shopper can rebuild.
 * Treating both as equally grave means crying wolf on the single most common
 * tool in commerce, so working state is graded down a level.
 */
function classify(tool: ToolRecord, parsed: ParsedName): Effect {
  if (tool.annotations?.consequential === true) return "consequential";
  if (tool.annotations?.readOnly === true) return "read";

  const risky = HIGH_RISK_VERBS.has(parsed.verb);
  if (risky && isWorkingState(parsed.object)) return "inferred";
  if (risky) return "consequential";
  if (MUTATING_VERBS.has(parsed.verb)) return "inferred";
  return "read";
}

/**
 * State a person is still assembling, rather than something committed. Losing
 * it is an annoyance to redo, not a loss to recover.
 */
function isWorkingState(object: string): boolean {
  if (object === "") return false;
  return object
    .split("_")
    .some((word) => WORKING_STATE.has(word));
}

const WORKING_STATE = new Set([
  "cart", "basket", "bag", "draft", "selection", "filter", "search", "query",
  "session", "preference", "wishlist", "favorite", "comparison", "form",
]);

export interface ParsedName {
  raw: string;
  verb: string;
  object: string;
}

/** `add_to_cart` → verb `add`, object `cart`; `createOrder` → `create`, `order`. */
export function parseName(name: string): ParsedName {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  const verb = words[0] ?? name.toLowerCase();
  const object = words
    .slice(1)
    .filter((word) => !FILLER.has(word))
    .map(singular)
    .join("_");

  return { raw: name, verb, object };
}

const FILLER = new Set(["to", "the", "a", "an", "from", "in", "for", "of", "my"]);

function singular(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") || word.endsWith("xes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Verbs whose effect is hard to walk back: money moves, or something is sent. */
const HIGH_RISK_VERBS = new Set([
  "checkout", "purchase", "buy", "order", "pay", "charge", "capture", "transfer",
  "send", "submit", "publish", "post", "delete", "destroy", "remove", "cancel",
  "refund", "book", "reserve", "confirm", "place", "execute", "deploy", "wipe",
]);

const MUTATING_VERBS = new Set([
  "create", "add", "update", "set", "edit", "modify", "patch", "put", "insert",
  "upload", "save", "apply", "assign", "invite", "subscribe", "unsubscribe",
  "enable", "disable", "start", "stop", "pause", "resume", "archive", "restore",
  "move", "rename", "share", "revoke", "grant", "approve", "reject", "schedule",
  ...HIGH_RISK_VERBS,
]);

/**
 * Inverse verbs, in preference order — the first match is what gets suggested
 * when nothing suitable exists on the page.
 */
const INVERSES: Record<string, string[]> = {
  create: ["delete", "remove", "destroy", "cancel", "archive"],
  add: ["remove", "delete", "discard"],
  insert: ["remove", "delete"],
  upload: ["delete", "remove"],
  save: ["delete", "discard", "revert"],
  update: ["revert", "restore", "undo"],
  edit: ["revert", "restore", "undo"],
  set: ["unset", "reset", "clear", "revert"],
  modify: ["revert", "restore"],
  patch: ["revert", "restore"],
  assign: ["unassign", "remove"],
  invite: ["uninvite", "revoke", "cancel"],
  subscribe: ["unsubscribe", "cancel"],
  enable: ["disable"],
  disable: ["enable"],
  start: ["stop", "cancel", "abort"],
  resume: ["pause", "stop"],
  pause: ["resume", "start"],
  archive: ["restore", "unarchive"],
  publish: ["unpublish", "delete", "retract"],
  post: ["delete", "remove", "retract"],
  share: ["unshare", "revoke"],
  grant: ["revoke"],
  approve: ["reject", "revoke", "undo"],
  book: ["cancel"],
  reserve: ["cancel", "release"],
  schedule: ["cancel", "unschedule"],
  order: ["cancel", "refund", "return"],
  place: ["cancel", "refund"],
  purchase: ["refund", "cancel", "return"],
  buy: ["refund", "cancel", "return"],
  checkout: ["cancel", "refund", "abort"],
  pay: ["refund", "reverse", "void"],
  charge: ["refund", "void", "reverse"],
  capture: ["refund", "void"],
  transfer: ["reverse", "refund"],
  send: ["recall", "unsend", "retract", "delete"],
  submit: ["withdraw", "cancel", "retract"],
  deploy: ["rollback", "revert", "undeploy"],
  delete: ["restore", "undelete", "recover"],
  remove: ["add", "restore"],
  cancel: [],
  refund: [],
  stop: [],
};

/** The tool that undoes a given one, if the surface has one. */
export function inverseOf(snapshot: Snapshot, toolName: string): string | undefined {
  const names = snapshot.tools.map((tool) => parseName(tool.name));
  const index = snapshot.tools.findIndex((tool) => tool.name === toolName);
  if (index === -1) return undefined;
  return findInverse(names[index]!, names, snapshot.tools, index);
}

/** Compensating actions that don't share the original's object, e.g. a global reset. */
const GLOBAL_INVERSE_VERBS = new Set(["undo", "rollback", "revert", "reset", "restore"]);

function findInverse(
  parsed: ParsedName,
  names: ParsedName[],
  tools: ToolRecord[],
  selfIndex: number,
): string | undefined {
  const wanted = INVERSES[parsed.verb] ?? [];

  for (const [index, candidate] of names.entries()) {
    if (index === selfIndex) continue;

    const verbMatches = wanted.includes(candidate.verb);
    const objectMatches =
      candidate.object === parsed.object ||
      (parsed.object !== "" && candidate.object.includes(parsed.object)) ||
      (candidate.object !== "" && parsed.object.includes(candidate.object)) ||
      // Verbs like `checkout` carry no object; pair them with order/cart/payment.
      (parsed.object === "" && DOMAIN_OBJECTS.has(candidate.object));

    if (verbMatches && objectMatches) return tools[index]!.name;
  }

  // A general-purpose undo covers everything on the page.
  for (const [index, candidate] of names.entries()) {
    if (index === selfIndex) continue;
    if (GLOBAL_INVERSE_VERBS.has(candidate.verb) && candidate.object === "") {
      return tools[index]!.name;
    }
  }

  return undefined;
}

const DOMAIN_OBJECTS = new Set(["order", "cart", "payment", "purchase", "checkout", "transaction"]);

function suggest(parsed: ParsedName): string {
  const options = INVERSES[parsed.verb] ?? ["undo"];
  const verb = options[0] ?? "undo";

  // Mirror the original phrasing: add_to_cart pairs with remove_from_cart.
  const suffix = parsed.raw.slice(parsed.verb.length).replace(/^[_-]/, "");
  const phrase = /(^|_)to(_|$)/.test(suffix)
    ? suffix.replace(/(^|_)to(_|$)/, "$1from$2")
    : parsed.object;

  const name = phrase ? `${verb}_${phrase}` : verb;
  return `${article(verb)} \`${name}\` tool`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
