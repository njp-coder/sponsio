import test from "node:test";
import assert from "node:assert/strict";
import { auditReversibility } from "../dist/index.js";

const snapshot = (tools) => ({
  sponsio: 1,
  url: "https://shop.example",
  capturedAt: "2026-09-05T00:00:00.000Z",
  tools: tools.map((t) => ({ description: "", kind: "imperative", ...t })),
});

const codes = (r) => r.findings.map((f) => f.code);
const forTool = (r, name) => r.findings.filter((f) => f.tool === name);
const find = (r, name, code) => forTool(r, name).find((f) => f.code === code);

test("read-only tools are not audited", () => {
  const result = auditReversibility(
    snapshot([{ name: "search_products", annotations: { readOnly: true } }]),
  );
  assert.equal(result.findings.length, 0);
});

// The headline case: 97% of scanned sites let an agent buy with no way back.
test("a consequential tool with no inverse is breaking", () => {
  const result = auditReversibility(
    snapshot([{ name: "checkout", annotations: { consequential: true } }]),
  );
  const finding = find(result, "checkout", "NO_INVERSE");
  assert.ok(finding);
  assert.equal(finding.severity, "breaking");
  assert.match(finding.message, /cancel/);
});

test("a matching inverse clears the finding", () => {
  const result = auditReversibility(
    snapshot([
      { name: "create_order", annotations: { consequential: true } },
      { name: "cancel_order" },
    ]),
  );
  const finding = find(result, "create_order", "INVERSE_FOUND");
  assert.ok(finding);
  assert.equal(finding.severity, "safe");
  assert.match(finding.message, /cancel_order/);
});

test("objectless verbs pair with domain objects", () => {
  const result = auditReversibility(
    snapshot([{ name: "checkout", annotations: { consequential: true } }, { name: "cancel_order" }]),
  );
  assert.ok(find(result, "checkout", "INVERSE_FOUND"));
});

test("a general undo tool covers everything", () => {
  const result = auditReversibility(
    snapshot([{ name: "publish_post", annotations: { consequential: true } }, { name: "undo" }]),
  );
  assert.ok(find(result, "publish_post", "INVERSE_FOUND"));
});

test("an inverse for a different object does not count", () => {
  const result = auditReversibility(
    snapshot([
      { name: "create_invoice", annotations: { consequential: true } },
      { name: "delete_comment" },
    ]),
  );
  assert.ok(find(result, "create_invoice", "NO_INVERSE"));
});

test("camelCase and plural names still pair up", () => {
  const result = auditReversibility(
    snapshot([{ name: "createOrders", annotations: { consequential: true } }, { name: "deleteOrder" }]),
  );
  assert.ok(find(result, "createOrders", "INVERSE_FOUND"));
});

test("add_to_cart pairs with remove_from_cart", () => {
  const result = auditReversibility(
    snapshot([{ name: "add_to_cart" }, { name: "remove_from_cart" }]),
  );
  assert.ok(find(result, "add_to_cart", "INVERSE_FOUND"));
});

// An unannotated destructive verb must not be mistaken for a read.
test("a risky verb is treated as consequential without any annotation", () => {
  const result = auditReversibility(snapshot([{ name: "delete_account" }]));
  assert.equal(find(result, "delete_account", "NO_INVERSE").severity, "breaking");
});

test("a mutating verb with no hint is flagged as undeclared", () => {
  const result = auditReversibility(snapshot([{ name: "update_profile" }]));
  assert.ok(find(result, "update_profile", "UNDECLARED_CONSEQUENCE"));
  assert.equal(find(result, "update_profile", "NO_INVERSE").severity, "warning");
});

test("declaring the hint silences the undeclared warning", () => {
  const result = auditReversibility(
    snapshot([{ name: "update_profile", annotations: { consequential: true } }]),
  );
  assert.equal(find(result, "update_profile", "UNDECLARED_CONSEQUENCE"), undefined);
});

test("a realistic shop surfaces exactly the irreversible action", () => {
  const result = auditReversibility(
    snapshot([
      { name: "search_products", annotations: { readOnly: true } },
      { name: "add_to_cart" },
      { name: "remove_from_cart" },
      { name: "checkout", annotations: { consequential: true } },
    ]),
  );
  assert.deepEqual(
    result.findings.filter((f) => f.code === "NO_INVERSE").map((f) => f.tool),
    ["checkout"],
  );
  assert.equal(result.counts.breaking, 1);
});
