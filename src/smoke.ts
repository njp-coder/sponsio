import { summarize } from "./diff.js";
import { buildValidInput } from "./conformance.js";
import type { LiveTool } from "./capture.js";
import type { DiffResult, Finding } from "./types.js";

export interface SmokeOptions {
  /**
   * Real arguments per tool name. A tool with a fixture is opted in to being
   * called even when it is not readOnly — writing real arguments for it is an
   * unambiguous statement of intent.
   */
  fixtures?: Record<string, unknown>;
  /** Call tools that are neither readOnly nor fixtured. */
  includeUnsafe?: boolean;
}

export interface SmokeResult {
  tool: string;
  status: "ok" | "rejected" | "unreachable" | "skipped";
  durationMs: number;
  /** Whether the arguments came from a fixture or were generated from the schema. */
  input: "fixture" | "generated" | "none";
  detail?: string;
}

/**
 * Does every tool actually work?
 *
 * The diff catches a contract that changed and the audit catches a surface that
 * is unsafe, but neither notices a tool that is registered, correctly shaped,
 * identical to its baseline, and simply broken. This calls each one and reports
 * a plain checklist.
 *
 * It proves tools respond. It does not prove they do the right thing — that is
 * agent-level evaluation, and it is a different, non-deterministic problem.
 */
export async function smokeTest(
  tools: LiveTool[],
  options: SmokeOptions = {},
): Promise<{ findings: Finding[]; results: SmokeResult[]; summary: DiffResult }> {
  const findings: Finding[] = [];
  const results: SmokeResult[] = [];
  const fixtures = options.fixtures ?? {};

  for (const tool of tools) {
    const fixture = Object.prototype.hasOwnProperty.call(fixtures, tool.name)
      ? fixtures[tool.name]
      : undefined;
    const fixtured = fixture !== undefined;

    if (!fixtured && !options.includeUnsafe && tool.annotations?.readOnly !== true) {
      results.push({ tool: tool.name, status: "skipped", durationMs: 0, input: "none" });
      findings.push({
        severity: "safe",
        code: "SMOKE_SKIPPED",
        tool: tool.name,
        message:
          `Not called: it is not declared readOnly and has no fixture. Give it real ` +
          `arguments in your fixtures file, or pass --probe-unsafe.`,
      });
      continue;
    }

    const input = fixtured ? fixture : buildValidInput(tool.inputSchema ?? {});
    const startedAt = Date.now();
    const outcome = await tool.execute(input);
    const durationMs = Date.now() - startedAt;

    if (outcome.status === "Completed") {
      results.push({
        tool: tool.name,
        status: "ok",
        durationMs,
        input: fixtured ? "fixture" : "generated",
      });
      findings.push({
        severity: "safe",
        code: "TOOL_OK",
        tool: tool.name,
        message: `Responded in ${durationMs}ms.`,
      });
      continue;
    }

    const detail = outcome.errorText?.trim() || `returned ${outcome.status}`;

    // A tool that never returns, or has no body to run, is broken by any
    // reading. One that rejects our arguments might just dislike them.
    if (UNREACHABLE.test(detail)) {
      results.push({
        tool: tool.name,
        status: "unreachable",
        durationMs,
        input: fixtured ? "fixture" : "generated",
        detail,
      });
      findings.push({
        severity: "breaking",
        code: "TOOL_UNREACHABLE",
        tool: tool.name,
        message: `Registered but not callable: ${truncate(detail)}`,
      });
      continue;
    }

    results.push({
      tool: tool.name,
      status: "rejected",
      durationMs,
      input: fixtured ? "fixture" : "generated",
      detail,
    });

    // Generated arguments satisfy the schema but not the world — a made-up
    // product id is *supposed* to be rejected. A fixture is the user saying
    // these arguments are real, so rejecting them is a genuine failure.
    findings.push(
      fixtured
        ? {
            severity: "breaking",
            code: "TOOL_REJECTED_INPUT",
            tool: tool.name,
            message: `Rejected the arguments you supplied: ${truncate(detail)}`,
          }
        : {
            severity: "warning",
            code: "TOOL_REJECTED_INPUT",
            tool: tool.name,
            message:
              `Rejected schema-valid generated arguments: ${truncate(detail)}. ` +
              `This may be correct — a generated id refers to nothing real. ` +
              `Add a fixture to make this check meaningful.`,
          },
    );
  }

  return { findings, results, summary: summarize(findings) };
}

/** Errors that mean the tool could not run at all, rather than disliking its input. */
const UNREACHABLE =
  /no execute|not a function|undefined is not|cannot read|timed out|timeout|detached|destroyed/i;

function truncate(text: string): string {
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
