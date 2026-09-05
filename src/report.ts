import type { DiffResult, Finding, Severity } from "./types.js";
import type { SmokeResult } from "./smoke.js";

const useColor = process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true;

const paint = (code: string, text: string): string =>
  useColor ? `[${code}m${text}[0m` : text;

const SEVERITY_STYLE: Record<Severity, { code: string; label: string }> = {
  breaking: { code: "31;1", label: "BREAKING" },
  warning: { code: "33;1", label: " WARNING" },
  safe: { code: "32", label: "    SAFE" },
};

export function renderConsole(result: DiffResult, baselineUrl: string): string {
  if (result.clean) {
    return paint("32", "✓ No contract changes.") + paint("2", `  ${baselineUrl}`);
  }

  const lines: string[] = [];
  let currentTool = "";
  for (const finding of result.findings) {
    if (finding.tool !== currentTool) {
      currentTool = finding.tool;
      lines.push("", paint("1", currentTool));
    }
    lines.push(`  ${badge(finding)} ${location(finding)}${finding.message}`);
  }

  lines.push("", summaryLine(result));
  return lines.join("\n");
}

function badge(finding: Finding): string {
  const style = SEVERITY_STYLE[finding.severity];
  return paint(style.code, style.label);
}

function location(finding: Finding): string {
  return finding.path ? paint("36", `${finding.path} `) : "";
}

function summaryLine(result: DiffResult): string {
  const parts = [
    result.counts.breaking > 0
      ? paint("31;1", `${result.counts.breaking} breaking`)
      : `${result.counts.breaking} breaking`,
    result.counts.warning > 0
      ? paint("33;1", `${result.counts.warning} warning`)
      : `${result.counts.warning} warning`,
    `${result.counts.safe} safe`,
  ];
  return parts.join(paint("2", " · "));
}

/**
 * The smoke checklist: the one output that needs no severity model explained
 * and no knowledge of WebMCP to read.
 */
export function renderChecklist(results: SmokeResult[]): string {
  if (results.length === 0) return paint("2", "No tools to call.");

  const width = Math.max(...results.map((r) => r.tool.length));
  const lines: string[] = [];

  for (const result of results) {
    const name = result.tool.padEnd(width);
    switch (result.status) {
      case "ok":
        lines.push(
          `  ${paint("32", "✓")} ${name}  ${paint("2", `${result.durationMs}ms`)}` +
            (result.input === "fixture" ? paint("2", "  fixture") : ""),
        );
        break;
      case "skipped":
        lines.push(`  ${paint("2", "·")} ${paint("2", name)}  ${paint("2", "not called")}`);
        break;
      default:
        lines.push(`  ${paint("31;1", "✗")} ${name}`);
        lines.push(`      ${paint("31", result.detail ?? result.status)}`);
    }
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const called = results.filter((r) => r.status !== "skipped").length;
  lines.push("", paint("1", `${ok}/${called} tools responded`));
  return lines.join("\n");
}

/** GitHub-flavoured markdown, sized for a PR comment or a step summary. */
export function renderMarkdown(result: DiffResult, url: string): string {
  if (result.clean) {
    return `### sponsio\n\n✅ No contract changes for \`${url}\`.\n`;
  }

  const icon: Record<Severity, string> = { breaking: "🛑", warning: "⚠️", safe: "✅" };
  const lines = [
    "### sponsio",
    "",
    `\`${url}\` — **${result.counts.breaking} breaking**, ` +
      `${result.counts.warning} warning, ${result.counts.safe} safe`,
    "",
    "| | Tool | Field | Change |",
    "| --- | --- | --- | --- |",
  ];

  for (const finding of result.findings) {
    const field = finding.path ? `\`${finding.path}\`` : "—";
    lines.push(
      `| ${icon[finding.severity]} | \`${finding.tool}\` | ${field} | ${escapeCell(finding.message)} |`,
    );
  }

  if (result.counts.breaking > 0) {
    lines.push(
      "",
      "> Breaking changes mean an agent mid-task against the old contract will fail. " +
        "Re-record the baseline only once that is intended: `sponsio snapshot`.",
    );
  }
  return lines.join("\n") + "\n";
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
