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
    seed_phrase: /a credential/,
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

test("session and bearer tokens count as credentials", () => {
  for (const name of ["session_token", "auth_token", "access_token"]) {
    const result = auditSafety(
      snapshot([charge({ type: "object", properties: { [name]: { type: "string" } } })]),
    );
    assert.ok(find(result, "SENSITIVE_PARAMETER"), `${name} should be flagged`);
  }
});

// A tool returning what other people wrote is an injection channel.
test("user-generated content without the untrusted hint is flagged", () => {
  const result = auditSafety(
    snapshot([{ name: "get_reviews", annotations: { readOnly: true } }]),
  );
  assert.equal(find(result, "UNDECLARED_UNTRUSTED_OUTPUT").severity, "warning");
});

test("declaring untrustedContent clears it", () => {
  const result = auditSafety(
    snapshot([{ name: "get_reviews", annotations: { readOnly: true, untrustedContent: true } }]),
  );
  assert.equal(find(result, "UNDECLARED_UNTRUSTED_OUTPUT"), undefined);
});

test("catalogue reads are not mistaken for user content", () => {
  const result = auditSafety(
    snapshot([{ name: "search_products", annotations: { readOnly: true } }]),
  );
  assert.equal(find(result, "UNDECLARED_UNTRUSTED_OUTPUT"), undefined);
});

// Authentication flows exist to prove a person is present.
test("sign-in, recovery, OTP and security changes are all breaking", () => {
  const cases = {
    login_user: /sign-in/,
    reset_password: /account recovery/,
    verify_otp: /one-time code/,
    change_recovery_email: /security settings/,
  };
  for (const [name, expected] of Object.entries(cases)) {
    const result = auditSafety(snapshot([{ name }]));
    const finding = find(result, "AUTHENTICATION_EXPOSED");
    assert.ok(finding, `${name} should be flagged`);
    assert.equal(finding.severity, "breaking");
    assert.match(finding.message, expected);
  }
});

test("ordinary tools are not mistaken for authentication", () => {
  for (const name of ["search_products", "add_to_cart", "get_order_status"]) {
    assert.equal(find(auditSafety(snapshot([{ name }])), "AUTHENTICATION_EXPOSED"), undefined);
  }
});

// A description saying the user will be prompted to log in describes the
// correct design. Accusing it of exposing authentication is a false positive,
// and this one was found on a real production storefront.
test("navigating a human to a login page is not exposing authentication", () => {
  const result = auditSafety(
    snapshot([{
      name: "manage_orders",
      description: "Navigate to the customer's order history page. The user will be prompted to log in if not already authenticated.",
    }]),
  );
  assert.equal(find(result, "AUTHENTICATION_EXPOSED"), undefined);
});

test("a tool that performs authentication is still caught by its name", () => {
  assert.ok(find(auditSafety(snapshot([{ name: "login_user" }])), "AUTHENTICATION_EXPOSED"));
  assert.ok(find(auditSafety(snapshot([{ name: "verify_otp" }])), "AUTHENTICATION_EXPOSED"));
});

// A second delete deletes nothing new.
test("naturally idempotent actions need no idempotency key", () => {
  for (const name of ["cancel_cart", "delete_item", "clear_cart", "unsubscribe_user"]) {
    const result = auditSafety(
      snapshot([{ name, annotations: { consequential: true }, inputSchema: { type: "object", properties: {} } }]),
    );
    assert.equal(find(result, "NO_IDEMPOTENCY_KEY"), undefined, `${name} should not need one`);
  }
});

test("actions that create or send still need one", () => {
  for (const name of ["charge_card", "send_receipt", "create_order"]) {
    const result = auditSafety(
      snapshot([{ name, annotations: { consequential: true }, inputSchema: { type: "object", properties: {} } }]),
    );
    assert.ok(find(result, "NO_IDEMPOTENCY_KEY"), `${name} should need one`);
  }
});
