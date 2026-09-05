import test from "node:test";
import assert from "node:assert/strict";
import { auditTasks } from "../dist/index.js";

const snapshot = (tools) => ({
  sponsio: 1, url: "https://shop.example", capturedAt: "2026-09-05T00:00:00.000Z",
  apiAvailable: true,
  tools: tools.map((t) => ({ description: "", kind: "imperative", ...t })),
});

const shop = snapshot([
  {
    name: "search_products",
    annotations: { readOnly: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        pillar: { type: "string", enum: ["home", "garden", "toys"] },
        max_price: { type: "number" },
      },
    },
  },
  { name: "add_to_cart", inputSchema: { type: "object", properties: { product_id: { type: "string" } } } },
  { name: "checkout", annotations: { consequential: true } },
]);

const codes = (r) => r.findings.map((f) => f.code);
const msg = (r) => r.findings.map((f) => f.message).join(" | ");

test("a task the surface can express is safe", () => {
  const r = auditTasks(shop, [{ name: "Search", needs: [{ tool: "search_products" }] }]);
  assert.deepEqual(codes(r), ["TASK_COVERED"]);
});

test("a missing tool fails the task by name", () => {
  const r = auditTasks(shop, [{ name: "Track my order", needs: [{ tool: "track_order" }] }]);
  assert.equal(r.findings[0].code, "TASK_UNSUPPORTED");
  assert.equal(r.findings[0].tool, "«Track my order»");
  assert.match(r.findings[0].message, /no `track_order` tool is registered/);
});

test("a missing parameter concept fails", () => {
  const r = auditTasks(shop, [
    { name: "Filter by colour", needs: [{ tool: "search_products", param: "color" }] },
  ]);
  assert.match(msg(r), /no parameter for “color”/);
});

// The whole point: a range needs more than a value.
test("a range requirement is met by a min/max style name", () => {
  const r = auditTasks(shop, [
    { name: "Under $50", needs: [{ param: "price", numeric: true, bounded: true }] },
  ]);
  assert.deepEqual(codes(r), ["TASK_COVERED"], "max_price should satisfy a bounded price");
});

test("a range requirement is met by declared constraints", () => {
  const bounded = snapshot([
    { name: "search", inputSchema: { type: "object", properties: { price: { type: "number", maximum: 500 } } } },
  ]);
  const r = auditTasks(bounded, [{ name: "Under", needs: [{ param: "price", bounded: true }] }]);
  assert.deepEqual(codes(r), ["TASK_COVERED"]);
});

test("an unbounded value cannot express under or over", () => {
  const plain = snapshot([
    { name: "search", inputSchema: { type: "object", properties: { price: { type: "number" } } } },
  ]);
  const r = auditTasks(plain, [{ name: "Under", needs: [{ param: "price", bounded: true }] }]);
  assert.match(msg(r), /not a range/);
});

test("a non-numeric parameter cannot carry a comparison", () => {
  const textual = snapshot([
    { name: "search", inputSchema: { type: "object", properties: { price: { type: "string" } } } },
  ]);
  const r = auditTasks(textual, [{ name: "Under", needs: [{ param: "price", numeric: true }] }]);
  assert.match(msg(r), /not numeric/);
});

// A dropped enum value is a journey that silently returns nothing.
test("a dropped enum value fails the journey that used it", () => {
  const r = auditTasks(shop, [
    { name: "Browse toys", needs: [{ param: "pillar", enumValue: "toys" }] },
  ]);
  assert.deepEqual(codes(r), ["TASK_COVERED"]);

  const regressed = snapshot([
    {
      name: "search_products",
      inputSchema: { type: "object", properties: { pillar: { type: "string", enum: ["home", "garden"] } } },
    },
  ]);
  const after = auditTasks(regressed, [
    { name: "Browse toys", needs: [{ param: "pillar", enumValue: "toys" }] },
  ]);
  assert.equal(after.findings[0].severity, "breaking");
  assert.match(after.findings[0].message, /silently returns nothing/);
});

test("a one-way journey is flagged as such", () => {
  const r = auditTasks(shop, [
    { name: "Buy and change your mind", needs: [{ reversible: "checkout" }] },
  ]);
  assert.match(msg(r), /nothing that undoes it/);

  const withCancel = snapshot([...shop.tools, { name: "cancel_order" }]);
  assert.deepEqual(
    codes(auditTasks(withCancel, [{ name: "Buy", needs: [{ reversible: "checkout" }] }])),
    ["TASK_COVERED"],
  );
});

test("parameter matching reads descriptions, not just names", () => {
  const described = snapshot([
    {
      name: "search",
      inputSchema: { type: "object", properties: { q: { type: "string", description: "Filter by colour" } } },
    },
  ]);
  const r = auditTasks(described, [{ name: "Colour", needs: [{ param: "colour" }] }]);
  assert.deepEqual(codes(r), ["TASK_COVERED"]);
});

test("every unmet need is reported, not just the first", () => {
  const r = auditTasks(shop, [
    { name: "Everything", needs: [{ tool: "nope" }, { param: "color" }, { reversible: "checkout" }] },
  ]);
  assert.equal(r.findings.length, 3);
});

test("a draft is generated from the surface, without inventing enum values", async () => {
  const { draftTasks } = await import("../dist/index.js");
  const draft = draftTasks(shop);

  assert.ok(draft.tasks.length > 0);
  assert.ok(draft.tasks.some((t) => t.needs.some((n) => n.reversible === "checkout")),
    "a consequential tool should be drafted with a reversibility need");
  // The guidance text mentions enumValue on purpose; the generated needs must not.
  assert.equal(
    JSON.stringify(draft.tasks).includes("enumValue"), false,
    "catalogue values are the user's to declare, never ours to guess",
  );
  assert.match(draft.$comment, /cry wolf/);
});

test("a surface with no annotations still yields something to start from", async () => {
  const { draftTasks } = await import("../dist/index.js");
  const bare = snapshot([{ name: "do_thing" }]);
  assert.equal(draftTasks(bare).tasks.length, 1);
});
