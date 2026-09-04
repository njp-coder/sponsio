import test from "node:test";
import assert from "node:assert/strict";
import { auditSurface, estimateTokens, similarity, shapeOf, compatible } from "../dist/index.js";

const snapshot = (tools) => ({
  sponsio: 1,
  url: "https://x.example",
  capturedAt: "2026-09-05T00:00:00.000Z",
  apiAvailable: true,
  tools: tools.map((t) => ({ description: "does a useful thing for you", kind: "imperative", ...t })),
});
const find = (r, code) => r.findings.find((f) => f.code === code);

test("a heavy tool surface is flagged with its cost", () => {
  const fat = Array.from({ length: 12 }, (_, i) => ({
    name: `tool_${i}`,
    description: "x".repeat(700),
    inputSchema: { type: "object", properties: {} },
  }));
  const finding = find(auditSurface(snapshot(fat)), "HEAVY_CONTEXT");
  assert.ok(finding);
  assert.match(finding.message, /tokens of the agent/);
});

test("a small surface costs nothing worth reporting", () => {
  assert.equal(find(auditSurface(snapshot([{ name: "search" }])), "HEAVY_CONTEXT"), undefined);
});

test("too many tools on one page is flagged", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `tool_${i}` }));
  assert.match(find(auditSurface(snapshot(many)), "TOO_MANY_TOOLS").message, /25 tools/);
});

test("a missing description is breaking", () => {
  assert.equal(
    find(auditSurface(snapshot([{ name: "search", description: "" }])), "MISSING_DESCRIPTION").severity,
    "breaking",
  );
});

test("a two-word description is too vague to select on", () => {
  assert.ok(find(auditSurface(snapshot([{ name: "search", description: "finds things" }])), "VAGUE_DESCRIPTION"));
});

test("near-identical descriptions are flagged as ambiguous", () => {
  const result = auditSurface(
    snapshot([
      { name: "find_products", description: "Search the catalog for matching products by name" },
      { name: "search_items", description: "Search the catalog for matching products by name" },
    ]),
  );
  const finding = find(result, "AMBIGUOUS_DESCRIPTIONS");
  assert.ok(finding);
  assert.match(finding.message, /search_items/);
});

test("genuinely different tools are left alone", () => {
  const result = auditSurface(
    snapshot([
      { name: "search_products", description: "Search the catalog by keyword and category" },
      { name: "cancel_order", description: "Cancel a placed order before it ships" },
    ]),
  );
  assert.equal(find(result, "AMBIGUOUS_DESCRIPTIONS"), undefined);
});

test("similarity ignores stopwords and is symmetric", () => {
  assert.ok(similarity("Search the catalog", "Search a catalog") > 0.8);
  assert.ok(similarity("Search the catalog", "Cancel an order") < 0.2);
});

test("token estimate grows with the surface", () => {
  const one = estimateTokens([{ name: "a", description: "b", kind: "imperative" }]);
  const many = estimateTokens(
    Array.from({ length: 10 }, () => ({ name: "a", description: "b".repeat(100), kind: "imperative" })),
  );
  assert.ok(many > one * 10);
});

// Response shape fingerprinting
test("result count does not change the shape", () => {
  const a = shapeOf({ items: [{ id: "1", name: "x" }] });
  const b = shapeOf({ items: [{ id: "2", name: "y" }, { id: "3", name: "z" }] });
  assert.equal(a, b);
});

test("a changed element type does change the shape", () => {
  assert.notEqual(shapeOf({ items: [{ id: "1" }] }), shapeOf({ items: ["1"] }));
});

test("an empty collection stays compatible with a populated one", () => {
  assert.ok(compatible(shapeOf({ items: [] }), shapeOf({ items: [{ id: "1" }] })));
});

test("incompatible shapes are not forced to match", () => {
  assert.equal(compatible(shapeOf({ ok: true }), shapeOf({ error: "nope" })), false);
});
