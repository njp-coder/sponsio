import test from "node:test";
import assert from "node:assert/strict";
import { probeRateLimits } from "../dist/index.js";

const tool = (name, behavior, annotations = { readOnly: true }) => ({
  name,
  description: "",
  kind: "imperative",
  annotations,
  inputSchema: { type: "object", properties: {} },
  execute: behavior,
});

const find = (r, code) => r.findings.find((f) => f.code === code);
const ok = async () => ({ status: "Completed" });

test("a tool that never throttles is flagged", async () => {
  const result = await probeRateLimits([tool("search", ok)], { calls: 10 });
  const finding = find(result, "NO_RATE_LIMIT");
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /10 calls back to back/);
});

test("rejections count as a rate limit", async () => {
  let calls = 0;
  const limited = async () =>
    ++calls > 3 ? { status: "Error", errorText: "429" } : { status: "Completed" };

  const result = await probeRateLimits([tool("search", limited)], { calls: 10 });
  const finding = find(result, "RATE_LIMITED");
  assert.equal(finding.severity, "safe");
  assert.match(finding.message, /Rejected 7 of 10/);
});

test("throttling by slowing down is detected too", async () => {
  let calls = 0;
  const slowing = async () => {
    calls++;
    // Real backpressure adds hundreds of ms; the detector ignores smaller jitter.
    if (calls > 5) await new Promise((r) => setTimeout(r, 300));
    return { status: "Completed" };
  };
  const result = await probeRateLimits([tool("search", slowing)], { calls: 12 });
  assert.match(find(result, "RATE_LIMITED").message, /Slowed down/);
});

test("millisecond noise is not mistaken for backpressure", async () => {
  const jittery = async () => {
    await new Promise((r) => setTimeout(r, Math.random() < 0.5 ? 0 : 1));
    return { status: "Completed" };
  };
  const result = await probeRateLimits([tool("search", jittery)], { calls: 12 });
  assert.ok(find(result, "NO_RATE_LIMIT"), "jitter alone should not read as throttling");
});

test("tools that are not read-only are skipped unless asked for", async () => {
  const writeTool = tool("charge_card", ok, { consequential: true });
  assert.equal((await probeRateLimits([writeTool], { calls: 5 })).findings.length, 0);
  assert.equal(
    (await probeRateLimits([writeTool], { calls: 5, includeUnsafe: true })).findings.length,
    1,
  );
});
