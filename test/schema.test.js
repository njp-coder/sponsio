import test from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, buildViolations, buildValidInput } from "../dist/index.js";

const snap = (inputSchema) => ({
  sponsio: 1,
  url: "https://shop.example",
  capturedAt: "2026-09-05T00:00:00.000Z",
  tools: [{ name: "t", description: "d", kind: "imperative", inputSchema }],
});

const between = (before, after) => diffSnapshots(snap(before), snap(after));
const find = (r, code) => r.findings.find((f) => f.code === code);

test("closing additionalProperties is breaking", () => {
  const r = between({ type: "object" }, { type: "object", additionalProperties: false });
  assert.equal(find(r, "ADDITIONAL_PROPERTIES_CLOSED").severity, "breaking");
});

test("opening additionalProperties is safe", () => {
  const r = between({ type: "object", additionalProperties: false }, { type: "object" });
  assert.equal(find(r, "ADDITIONAL_PROPERTIES_OPENED").severity, "safe");
});

test("pinning a const is breaking, releasing it is safe", () => {
  assert.equal(
    find(between({ type: "string" }, { type: "string", const: "x" }), "CONST_ADDED").severity,
    "breaking",
  );
  assert.equal(
    find(between({ type: "string", const: "x" }, { type: "string" }), "CONST_REMOVED").severity,
    "safe",
  );
});

test("changing a const is breaking", () => {
  const r = between({ const: "a" }, { const: "b" });
  assert.equal(find(r, "CONST_CHANGED").severity, "breaking");
});

// Fewer alternatives accepts less; more requirements also accepts less.
test("losing an anyOf branch is breaking, gaining one is safe", () => {
  const two = { anyOf: [{ type: "string" }, { type: "number" }] };
  const one = { anyOf: [{ type: "string" }] };
  assert.equal(find(between(two, one), "COMBINATOR_BRANCH_REMOVED").severity, "breaking");
  assert.equal(find(between(one, two), "COMBINATOR_BRANCH_ADDED").severity, "safe");
});

test("allOf inverts: gaining a requirement is breaking", () => {
  const one = { allOf: [{ type: "object" }] };
  const two = { allOf: [{ type: "object" }, { required: ["x"] }] };
  assert.equal(find(between(one, two), "COMBINATOR_BRANCH_ADDED").severity, "breaking");
  assert.equal(find(between(two, one), "COMBINATOR_BRANCH_REMOVED").severity, "safe");
});

test("changes inside a combinator branch are found", () => {
  const r = between(
    { oneOf: [{ type: "string" }] },
    { oneOf: [{ type: "number" }] },
  );
  const finding = find(r, "TYPE_CHANGED");
  assert.ok(finding);
  assert.equal(finding.path, "oneOf[0]");
});

test("$ref is resolved before comparing", () => {
  const before = {
    type: "object",
    properties: { user: { $ref: "#/$defs/user" } },
    $defs: { user: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  };
  const after = structuredClone(before);
  after.$defs.user.properties.id.type = "number";

  const finding = find(between(before, after), "TYPE_CHANGED");
  assert.ok(finding, "a change behind a $ref should still be caught");
  assert.equal(finding.path, "user.id");
});

test("recursive $ref terminates", () => {
  const schema = {
    type: "object",
    properties: { node: { $ref: "#/$defs/node" } },
    $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
  };
  const result = between(schema, structuredClone(schema));
  assert.equal(result.clean, true);
});

test("shortening a tuple is breaking, extending it is safe", () => {
  const two = { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] };
  const one = { type: "array", prefixItems: [{ type: "string" }] };
  assert.equal(find(between(two, one), "TUPLE_SHORTENED").severity, "breaking");
  assert.equal(find(between(one, two), "TUPLE_EXTENDED").severity, "safe");
});

test("array-form items is treated as a tuple too", () => {
  const r = between(
    { type: "array", items: [{ type: "string" }, { type: "string" }] },
    { type: "array", items: [{ type: "string" }] },
  );
  assert.ok(find(r, "TUPLE_SHORTENED"));
});

test("violation probes break exactly one rule each", () => {
  const violations = buildViolations({
    type: "object",
    properties: {
      query: { type: "string", maxLength: 10 },
      pillar: { type: "string", enum: ["home", "garden"] },
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
    required: ["query"],
  });

  const codes = violations.map((v) => v.description);
  assert.ok(codes.some((d) => /required .*query.* missing/.test(d)));
  assert.ok(codes.some((d) => /outside its enum/.test(d)));
  assert.ok(codes.some((d) => /above its maximum of 50/.test(d)));
  assert.ok(codes.some((d) => /below its minimum of 1/.test(d)));
  assert.ok(codes.some((d) => /longer than its maxLength of 10/.test(d)));

  const omission = violations.find((v) => /missing/.test(v.description));
  assert.equal("query" in omission.input, false);
});

test("the valid base input satisfies required fields and declared ranges", () => {
  const input = buildValidInput({
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "number", minimum: 5, maximum: 9 },
      mode: { type: "string", enum: ["fast", "slow"] },
      optional: { type: "string" },
    },
    required: ["name", "count", "mode"],
  });

  assert.equal(typeof input.name, "string");
  assert.ok(input.count >= 5 && input.count <= 9);
  assert.equal(input.mode, "fast");
  assert.equal("optional" in input, false);
});
