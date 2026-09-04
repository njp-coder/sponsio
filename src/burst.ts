import { summarize } from "./diff.js";
import { buildValidInput } from "./conformance.js";
import type { LiveTool } from "./capture.js";
import type { DiffResult, Finding } from "./types.js";

export interface BurstOptions {
  /** How many calls to fire at each tool. */
  calls: number;
  /** Include tools not declared readOnly. Off by default: this really calls them, repeatedly. */
  includeUnsafe?: boolean;
}

/**
 * Does anything stop an agent calling this as fast as it can?
 *
 * Agents loop. The most-read agent incident of the year was an operator waking
 * to a $6,531 bill after one retried a failing action all night, and every
 * framework retries on error by default. A human clicking a button is
 * self-limiting; an agent is not, so a tool with no throttle has no floor on
 * what a confused model can cost you.
 *
 * Rate limiting cannot be read off a schema — WebMCP has no field for it — so
 * this measures the behavior instead: call the tool as fast as possible and
 * watch for rejections or for the site slowing down on purpose.
 */
export async function probeRateLimits(
  tools: LiveTool[],
  options: BurstOptions,
): Promise<DiffResult> {
  const findings: Finding[] = [];
  const candidates = tools.filter(
    (tool) => options.includeUnsafe || tool.annotations?.readOnly === true,
  );

  for (const tool of candidates) {
    const input = buildValidInput(tool.inputSchema ?? {});
    const durations: number[] = [];
    let rejected = 0;

    for (let attempt = 0; attempt < options.calls; attempt++) {
      const started = Date.now();
      const result = await tool.execute(input);
      durations.push(Date.now() - started);
      if (result.status !== "Completed") rejected++;
    }

    if (rejected > 0) {
      findings.push({
        severity: "safe",
        code: "RATE_LIMITED",
        tool: tool.name,
        message: `Rejected ${rejected} of ${options.calls} rapid calls — a runaway agent is capped.`,
      });
      continue;
    }

    if (throttledByDelay(durations)) {
      findings.push({
        severity: "safe",
        code: "RATE_LIMITED",
        tool: tool.name,
        message: `Slowed down under a burst of ${options.calls} calls, which brakes a retry loop.`,
      });
      continue;
    }

    findings.push({
      severity: "warning",
      code: "NO_RATE_LIMIT",
      tool: tool.name,
      message:
        `Accepted ${options.calls} calls back to back with no throttling. Agents retry ` +
        `on error by default, so nothing here limits what a loop can cost you.`,
    });
  }

  return summarize(findings);
}

/**
 * A site can throttle by refusing or by stalling. Comparing the two halves of
 * the burst catches the second — with a floor, so millisecond noise on a local
 * fixture doesn't read as backpressure.
 */
function throttledByDelay(durations: number[]): boolean {
  if (durations.length < 6) return false;
  const middle = Math.floor(durations.length / 2);
  const first = median(durations.slice(0, middle));
  const second = median(durations.slice(middle));
  return second > Math.max(first * 3, first + 250);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}
