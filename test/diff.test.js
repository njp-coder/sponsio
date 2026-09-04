import test from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, shouldFail } from "../dist/index.js";

const snapshot = (tools) => ({
  sponsio: 1,
  url: "https://shop.example",
  capturedAt: "2026-09-05T00:00:00.000Z",
  tools,
});

const tool = (overrides = {}) => ({
  name: "search_products",
  description: "Search the catalog",
  kind: "imperative",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  ...overrides,
});

const codes = (result) => result.findings.map((f) => f.code);
const find = (result, code) => result.findings.find((f) => f.code === code);

test("identical snapshots are clean", () => {
  const result = diffSnapshots(snapshot([tool()]), snapshot([tool()]));
  assert.equal(result.clean, true);
  assert.equal(result.counts.breaking, 0);
});

test("a removed tool is breaking", () => {
  const result = diffSnapshots(snapshot([tool()]), snapshot([]));
  assert.deepEqual(codes(result), ["TOOL_REMOVED"]);
  assert.equal(result.counts.breaking, 1);
});

test("a new tool is safe", () => {
  const result = diffSnapshots(snapshot([]), snapshot([tool()]));
  assert.deepEqual(codes(result), ["TOOL_ADDED"]);
  assert.equal(result.counts.safe, 1);
});

test("a newly required property is breaking", () => {
  const after = tool({
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, locale: { type: "string" } },
      required: ["query", "locale"],
    },
  });
  const result = diffSnapshots(snapshot([tool()]), snapshot([after]));
  const finding = find(result, "REQUIRED_ADDED");
  assert.ok(finding);
  assert.equal(finding.severity, "breaking");
  assert.equal(finding.path, "locale");
});

test("a new optional property is safe", () => {
  const after = tool({
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, locale: { type: "string" } },
      required: ["query"],
    },
  });
  const result = diffSnapshots(snapshot([tool()]), snapshot([after]));
  assert.deepEqual(codes(result), ["PROPERTY_ADDED"]);
  assert.equal(result.counts.breaking, 0);
});

test("relaxing a required property is safe", () => {
  const after = tool({
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: [] },
  });
  const result = diffSnapshots(snapshot([tool()]), snapshot([after]));
  assert.deepEqual(codes(result), ["REQUIRED_REMOVED"]);
});

test("a changed property type is breaking", () => {
  const after = tool({
    inputSchema: {
      type: "object",
      properties: { query: { type: "number" } },
      required: ["query"],
    },
  });
  const result = diffSnapshots(snapshot([tool()]), snapshot([after]));
  const finding = find(result, "TYPE_CHANGED");
  assert.equal(finding.severity, "breaking");
  assert.equal(finding.path, "query");
});

// The silent killer: the call still returns 200, just with nothing in it.
test("a removed enum value is breaking", () => {
  const before = tool({
    inputSchema: {
      type: "object",
      properties: { pillar: { type: "string", enum: ["home", "garden", "toys"] } },
    },
  });
  const after = tool({
    inputSchema: {
      type: "object",
      properties: { pillar: { type: "string", enum: ["home", "garden"] } },
    },
  });
  const result = diffSnapshots(snapshot([before]), snapshot([after]));
  const finding = find(result, "ENUM_VALUE_REMOVED");
  assert.equal(finding.severity, "breaking");
  assert.match(finding.message, /"toys"/);
});

test("an added enum value is safe", () => {
  const before = tool({
    inputSchema: { type: "object", properties: { pillar: { enum: ["home"] } } },
  });
  const after = tool({
    inputSchema: { type: "object", properties: { pillar: { enum: ["home", "garden"] } } },
  });
  const result = diffSnapshots(snapshot([before]), snapshot([after]));
  assert.deepEqual(codes(result), ["ENUM_VALUE_ADDED"]);
});

test("description changes are warnings, because the model selects on them", () => {
  const after = tool({ description: "Find items in the store" });
  const result = diffSnapshots(snapshot([tool()]), snapshot([after]));
  const finding = find(result, "DESCRIPTION_CHANGED");
  assert.equal(finding.severity, "warning");
});

test("losing the readOnly hint is breaking", () => {
  const before = tool({ annotations: { readOnly: true } });
  const after = tool({ annotations: { readOnly: false } });
  const result = diffSnapshots(snapshot([before]), snapshot([after]));
  const finding = find(result, "READONLY_REMOVED");
  assert.equal(finding.severity, "breaking");
});

test("losing the consequential hint is breaking", () => {
  const before = tool({ name: "checkout", annotations: { consequential: true } });
  const after = tool({ name: "checkout", annotations: {} });
  const result = diffSnapshots(snapshot([before]), snapshot([after]));
  assert.equal(find(result, "CONSEQUENTIAL_REMOVED").severity, "breaking");
});

test("gaining the consequential hint is a warning", () => {
  const before = tool({ name: "checkout" });
  const after = tool({ name: "checkout", annotations: { consequential: true } });
  const result = diffSnapshots(snapshot([before]), snapshot([after]));
  assert.equal(find(result, "CONSEQUENTIAL_ADDED").severity, "warning");
});

test("tightening a numeric bound is breaking, loosening is safe", () => {
  const before = tool({
    inputSchema: { type: "object", properties: { limit: { type: "number", maximum: 100 } } },
  });
  const tightened = tool({
    inputSchema: { type: "object", properties: { limit: { type: "number", maximum: 10 } } },
  });
  const loosened = tool({
    inputSchema: { type: "object", properties: { limit: { type: "number", maximum: 500 } } },
  });

  assert.equal(
    find(diffSnapshots(snapshot([before]), snapshot([tightened])), "CONSTRAINT_NARROWED").severity,
    "breaking",
  );
  assert.equal(
    find(diffSnapshots(snapshot([before]), snapshot([loosened])), "CONSTRAINT_RELAXED").severity,
    "safe",
  );
});

test("a brand-new constraint is breaking", () => {
  const after = tool({
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 20 } },
      required: ["query"],
    },
  });
  const result = diffSnapshots(snapshot([tool()]), snapshot([after]));
  assert.equal(find(result, "CONSTRAINT_ADDED").severity, "breaking");
});

test("nested object properties are compared by path", () => {
  const before = tool({
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "object", properties: { color: { type: "string" } }, required: [] },
      },
    },
  });
  const after = tool({
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { color: { type: "string" } },
          required: ["color"],
        },
      },
    },
  });
  const result = diffSnapshots(snapshot([before]), snapshot([after]));
  assert.equal(find(result, "REQUIRED_ADDED").path, "filter.color");
});

test("dropping the input schema is a warning", () => {
  const after = { ...tool(), inputSchema: undefined };
  const result = diffSnapshots(snapshot([tool()]), snapshot([after]));
  assert.equal(find(result, "SCHEMA_REMOVED").severity, "warning");
});

test("findings sort breaking first", () => {
  const before = tool({ annotations: { readOnly: true } });
  const after = tool({ description: "changed", annotations: { readOnly: false } });
  const result = diffSnapshots(snapshot([before]), snapshot([after]));
  assert.equal(result.findings[0].severity, "breaking");
});

test("shouldFail honors the threshold", () => {
  const warned = diffSnapshots(snapshot([tool()]), snapshot([tool({ description: "new" })]));
  assert.equal(shouldFail(warned, "breaking"), false);
  assert.equal(shouldFail(warned, "warning"), true);
  assert.equal(shouldFail(warned, "never"), false);

  const broke = diffSnapshots(snapshot([tool()]), snapshot([]));
  assert.equal(shouldFail(broke, "breaking"), true);
});
