import test from "node:test";
import assert from "node:assert/strict";
import { auditSafety } from "../dist/index.js";

const snapshot = (tools) => ({
  sponsio: 1,
  url: "https://shop.example",
  capturedAt: "2026-09-05T00:00:00.000Z",
  tools: tools.map((t) => ({ description: "", kind: "imperative", ...t })),
});

const find = (r, code) => r.findings.find((f) => f.code === code);
const all = (r, code) => r.findings.filter((f) => f.code === code);

const charge = (schema, extra = {}) => ({
  name: "charge_card",
  annotations: { consequential: true },
  inputSchema: schema,
  ...extra,
});

test("a consequential tool with no idempotency key is breaking", () => {
  const result = auditSafety(
    snapshot([charge({ type: "object", properties: { amount: { type: "number" } } })]),
  );
  assert.equal(find(result, "NO_IDEMPOTENCY_KEY").severity, "breaking");
});

test("an idempotency key clears it, under any of its common names", () => {
  for (const key of ["idempotency_key", "idempotencyKey", "request_id", "clientToken", "dedupe_key"]) {
    const result = auditSafety(
      snapshot([charge({ type: "object", properties: { [key]: { type: "string" } } })]),
    );
    assert.equal(find(result, "NO_IDEMPOTENCY_KEY"), undefined, `${key} should count`);
  }
});

test("read-only tools need no idempotency key", () => {
  const result = auditSafety(
    snapshot([
      { name: "search", annotations: { readOnly: true }, inputSchema: { type: "object", properties: {} } },
    ]),
  );
  assert.equal(find(result, "NO_IDEMPOTENCY_KEY"), undefined);
});

test("raw card details are flagged", () => {
  const result = auditSafety(
    snapshot([
      charge({
        type: "object",
        properties: { card_number: { type: "string" }, cvv: { type: "string" } },
      }),
    ]),
  );
  const findings = all(result, "SENSITIVE_PARAMETER");
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, "breaking");
  assert.deepEqual(findings.map((f) => f.path).sort(), ["card_number", "cvv"]);
});

test("passwords, government ids, secrets and bank details are all flagged", () => {
  const cases = {
    password: /password or PIN/,
    ssn: /government identity/,
    seed_phrase: /secret key/,
    routing_number: /bank details/,
  };
  for (const [name, expected] of Object.entries(cases)) {
    const result = auditSafety(
      snapshot([charge({ type: "object", properties: { [name]: { type: "string" } } })]),
    );
    const finding = find(result, "SENSITIVE_PARAMETER");
    assert.ok(finding, `${name} should be flagged`);
    assert.match(finding.message, expected);
  }
});

test("a sensitive field is caught inside a nested object", () => {
  const result = auditSafety(
    snapshot([
      charge({
        type: "object",
        properties: {
          payment: { type: "object", properties: { cvv: { type: "string" } } },
        },
      }),
    ]),
  );
  assert.equal(find(result, "SENSITIVE_PARAMETER").path, "payment.cvv");
});

test("a description mentioning card details is enough to flag it", () => {
  const result = auditSafety(
    snapshot([
      charge({
        type: "object",
        properties: { value: { type: "string", description: "The full card number" } },
      }),
    ]),
  );
  assert.ok(find(result, "SENSITIVE_PARAMETER"));
});

test("ordinary parameters are not flagged", () => {
  const result = auditSafety(
    snapshot([
      charge({
        type: "object",
        properties: {
          amount: { type: "number" },
          currency: { type: "string" },
          idempotency_key: { type: "string" },
          note: { type: "string", description: "Message shown on the receipt" },
        },
      }),
    ]),
  );
  assert.equal(result.findings.filter((f) => f.code === "SENSITIVE_PARAMETER").length, 0);
});

// Structural reversibility and effective reversibility are different things.
test("actions whose effect escapes are flagged even when an inverse exists", () => {
  const result = auditSafety(
    snapshot([
      { name: "send_message", inputSchema: { type: "object", properties: {} } },
      { name: "recall_message" },
    ]),
  );
  assert.equal(find(result, "EFFECT_ESCAPES").severity, "warning");
});

test("purely local state changes do not escape", () => {
  const result = auditSafety(
    snapshot([{ name: "add_to_cart", inputSchema: { type: "object", properties: {} } }]),
  );
  assert.equal(find(result, "EFFECT_ESCAPES"), undefined);
});

test("an unbounded money or quantity parameter is flagged", () => {
  const result = auditSafety(
    snapshot([charge({ type: "object", properties: { amount: { type: "number", minimum: 1 } } })]),
  );
  const finding = find(result, "UNBOUNDED_MAGNITUDE");
  assert.equal(finding.severity, "warning");
  assert.equal(finding.path, "amount");
});

test("a declared maximum clears it", () => {
  const result = auditSafety(
    snapshot([charge({ type: "object", properties: { amount: { type: "number", maximum: 500 } } })]),
  );
  assert.equal(find(result, "UNBOUNDED_MAGNITUDE"), undefined);
});

test("non-magnitude numbers are left alone", () => {
  const result = auditSafety(
    snapshot([charge({ type: "object", properties: { page: { type: "number" } } })]),
  );
  assert.equal(find(result, "UNBOUNDED_MAGNITUDE"), undefined);
});

test("a tool that grants access without the consequential hint is breaking", () => {
  const result = auditSafety(
    snapshot([{ name: "grant_role", inputSchema: { type: "object", properties: {} } }]),
  );
  assert.equal(find(result, "GRANTS_ACCESS").severity, "breaking");
});

test("declaring the hint downgrades it to a warning", () => {
  const result = auditSafety(
    snapshot([
      {
        name: "create_api_key",
        annotations: { consequential: true },
        inputSchema: { type: "object", properties: { idempotency_key: { type: "string" } } },
      },
    ]),
  );
  assert.equal(find(result, "GRANTS_ACCESS").severity, "warning");
});
