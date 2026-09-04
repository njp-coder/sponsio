import test from "node:test";
import assert from "node:assert/strict";
import { auditSafety } from "../dist/index.js";

const snapshot = (tools) => ({
  sponsio: 1,
  url: "https://svc.example",
  capturedAt: "2026-09-05T00:00:00.000Z",
  apiAvailable: true,
  tools: tools.map((t) => ({ description: "", kind: "imperative", ...t })),
});
const find = (r, code) => r.findings.find((f) => f.code === code);

// Read-only is not the same as harmless: export_all_customers is both.
test("a bulk read with no page cap is flagged even though it is read-only", () => {
  const result = auditSafety(
    snapshot([
      {
        name: "export_all_customers",
        annotations: { readOnly: true },
        inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      },
    ]),
  );
  const finding = find(result, "UNBOUNDED_DATA_EGRESS");
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /no maximum/);
});

test("a bounded page size clears it", () => {
  const result = auditSafety(
    snapshot([
      {
        name: "list_orders",
        annotations: { readOnly: true },
        inputSchema: { type: "object", properties: { limit: { type: "number", maximum: 100 } } },
      },
    ]),
  );
  assert.equal(find(result, "UNBOUNDED_DATA_EGRESS"), undefined);
});

test("a bulk read with no pagination at all is flagged", () => {
  const result = auditSafety(
    snapshot([
      { name: "download_report", annotations: { readOnly: true }, inputSchema: { type: "object", properties: {} } },
    ]),
  );
  assert.match(find(result, "UNBOUNDED_DATA_EGRESS").message, /no page-size parameter/);
});

test("a caller-supplied subject id is breaking on a mutating tool", () => {
  const result = auditSafety(
    snapshot([
      {
        name: "update_profile",
        inputSchema: { type: "object", properties: { user_id: { type: "string" } } },
      },
    ]),
  );
  const finding = find(result, "CALLER_CHOSEN_SUBJECT");
  assert.equal(finding.severity, "breaking");
  assert.equal(finding.path, "user_id");
});

test("a caller-supplied subject id is a warning on a read", () => {
  const result = auditSafety(
    snapshot([
      {
        name: "get_profile",
        annotations: { readOnly: true },
        inputSchema: { type: "object", properties: { customerId: { type: "string" } } },
      },
    ]),
  );
  assert.equal(find(result, "CALLER_CHOSEN_SUBJECT").severity, "warning");
});

test("ordinary identifiers are not mistaken for subjects", () => {
  const result = auditSafety(
    snapshot([
      {
        name: "get_order",
        annotations: { readOnly: true },
        inputSchema: { type: "object", properties: { order_id: { type: "string" }, product_id: { type: "string" } } },
      },
    ]),
  );
  assert.equal(find(result, "CALLER_CHOSEN_SUBJECT"), undefined);
});

// A site that offers a service, not a transaction.
test("work an agent cannot observe or cancel is flagged", () => {
  const result = auditSafety(
    snapshot([{ name: "generate_report", inputSchema: { type: "object", properties: {} } }]),
  );
  assert.match(find(result, "UNOBSERVABLE_WORK").message, /check progress or cancel it/);
});

test("a status tool alone still leaves it uncancellable", () => {
  const result = auditSafety(
    snapshot([
      { name: "generate_report", inputSchema: { type: "object", properties: {} } },
      { name: "get_report_status", annotations: { readOnly: true } },
    ]),
  );
  assert.match(find(result, "UNOBSERVABLE_WORK").message, /cancel it/);
});

test("status and cancel together clear it", () => {
  const result = auditSafety(
    snapshot([
      { name: "generate_report", inputSchema: { type: "object", properties: {} } },
      { name: "get_report_status", annotations: { readOnly: true } },
      { name: "cancel_report" },
    ]),
  );
  assert.equal(find(result, "UNOBSERVABLE_WORK"), undefined);
});

test("a generic job status and cancel pair also counts", () => {
  const result = auditSafety(
    snapshot([
      { name: "transcribe_audio", inputSchema: { type: "object", properties: {} } },
      { name: "get_job_status", annotations: { readOnly: true } },
      { name: "cancel_job" },
    ]),
  );
  assert.equal(find(result, "UNOBSERVABLE_WORK"), undefined);
});

test("instant tools are not treated as long-running", () => {
  const result = auditSafety(
    snapshot([{ name: "add_to_cart", inputSchema: { type: "object", properties: {} } }]),
  );
  assert.equal(find(result, "UNOBSERVABLE_WORK"), undefined);
});
