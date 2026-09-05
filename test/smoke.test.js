import test from "node:test";
import assert from "node:assert/strict";
import { smokeTest } from "../dist/index.js";

const tool = (name, execute, annotations = { readOnly: true }, inputSchema = { type: "object", properties: {} }) =>
  ({ name, description: "", kind: "imperative", annotations, inputSchema, execute });

const ok = async () => ({ status: "Completed" });
const rejects = async () => ({ status: "Error", errorText: "unknown product" });
const dead = async () => ({ status: "Error", errorText: "This build exposes no execute() for tools." });

const find = (r, code) => r.findings.find((f) => f.code === code);
const resultFor = (r, name) => r.results.find((x) => x.tool === name);

test("a working tool passes and is timed", async () => {
  const r = await smokeTest([tool("search", ok)]);
  assert.equal(resultFor(r, "search").status, "ok");
  assert.equal(find(r, "TOOL_OK").severity, "safe");
});

test("a tool that cannot run at all is breaking", async () => {
  const r = await smokeTest([tool("broken", dead)]);
  assert.equal(resultFor(r, "broken").status, "unreachable");
  assert.equal(find(r, "TOOL_UNREACHABLE").severity, "breaking");
});

// Generated arguments satisfy the schema but not the world.
test("rejecting generated arguments is only a warning", async () => {
  const r = await smokeTest([tool("add_to_cart", rejects)]);
  const finding = find(r, "TOOL_REJECTED_INPUT");
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /may be correct/);
  assert.equal(resultFor(r, "add_to_cart").input, "generated");
});

test("rejecting arguments you supplied is breaking", async () => {
  const r = await smokeTest([tool("add_to_cart", rejects)], {
    fixtures: { add_to_cart: { product_id: "p1" } },
  });
  const finding = find(r, "TOOL_REJECTED_INPUT");
  assert.equal(finding.severity, "breaking");
  assert.match(finding.message, /arguments you supplied/);
  assert.equal(resultFor(r, "add_to_cart").input, "fixture");
});

test("write tools are skipped unless fixtured or explicitly allowed", async () => {
  const write = tool("checkout", ok, { consequential: true });

  const skipped = await smokeTest([write]);
  assert.equal(resultFor(skipped, "checkout").status, "skipped");
  assert.ok(find(skipped, "SMOKE_SKIPPED"));

  const allowed = await smokeTest([write], { includeUnsafe: true });
  assert.equal(resultFor(allowed, "checkout").status, "ok");
});

// Writing real arguments for a tool is an unambiguous request to call it.
test("a fixture opts a write tool in", async () => {
  const r = await smokeTest([tool("checkout", ok, { consequential: true })], {
    fixtures: { checkout: { email: "a@b.com" } },
  });
  assert.equal(resultFor(r, "checkout").status, "ok");
});

test("a fixture of undefined does not count as supplied", async () => {
  const r = await smokeTest([tool("checkout", ok, { consequential: true })], {
    fixtures: { other_tool: {} },
  });
  assert.equal(resultFor(r, "checkout").status, "skipped");
});

test("results keep their order and cover every tool", async () => {
  const r = await smokeTest([tool("a", ok), tool("b", rejects), tool("c", ok)]);
  assert.deepEqual(r.results.map((x) => x.tool), ["a", "b", "c"]);
  assert.equal(r.summary.counts.warning, 1);
});
