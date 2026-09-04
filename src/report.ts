import type { DiffResult, Finding, Severity } from "./types.js";

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

/** GitHub-flavoured markdown, sized for a PR comment or a step summary. */
export function renderMarkdown(result: DiffResult, url: string): string {
  if (result.clean) {
    return `### toolpact\n\n✅ No contract changes for \`${url}\`.\n`;
  }

  const icon: Record<Severity, string> = { breaking: "🛑", warning: "⚠️", safe: "✅" };
  const lines = [
    "### toolpact",
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
        "Re-record the baseline only once that is intended: `toolpact snapshot`.",
    );
  }
  return lines.join("\n") + "\n";
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
