#!/usr/bin/env node
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Command } from "commander";
import { capture, withSession, SponsioError } from "./capture.js";
import { diffSnapshots, shouldFail, summarize, type FailOn } from "./diff.js";
import { auditReversibility } from "./reversibility.js";
import { auditSafety } from "./safety.js";
import { probeConformance } from "./conformance.js";
import { renderConsole, renderMarkdown } from "./report.js";
import type { DiffResult, Finding, Snapshot } from "./types.js";

const DEFAULT_BASELINE = "sponsio.baseline.json";

const program = new Command()
  .name("sponsio")
  .description("Contract testing for the tools your site exposes to AI agents")
  .version("0.2.0");

program
  .command("snapshot")
  .argument("<url>", "page to load (https, or localhost)")
  .description("record the current tool contract as a baseline")
  .option("-o, --out <file>", "where to write the baseline", DEFAULT_BASELINE)
  .option("--settle <ms>", "quiet period before reading tools", "400")
  .option("--timeout <ms>", "hard ceiling on the wait", "10000")
  .option("--executable-path <path>", "Chrome 151+ binary to use")
  .option("--no-headless", "run with a visible browser")
  .action(async (url: string, options) => {
    const snapshot = await run(() =>
      capture({
        url,
        settleMs: Number(options.settle),
        timeoutMs: Number(options.timeout),
        executablePath: options.executablePath,
        headless: options.headless,
      }),
    );
    await writeJson(options.out, snapshot);
    console.log(
      `Recorded ${snapshot.tools.length} tool${snapshot.tools.length === 1 ? "" : "s"} → ${options.out}`,
    );
    for (const tool of snapshot.tools) {
      const flags = [
        tool.kind === "declarative" ? "declarative" : null,
        tool.annotations?.readOnly ? "readOnly" : null,
        tool.annotations?.consequential ? "consequential" : null,
      ].filter(Boolean);
      console.log(`  ${tool.name}${flags.length ? `  (${flags.join(", ")})` : ""}`);
    }
  });

program
  .command("check")
  .argument("<url>", "page to load (https, or localhost)")
  .description("capture the live contract and compare it against the baseline")
  .option("-b, --baseline <file>", "baseline to compare against", DEFAULT_BASELINE)
  .option("--fail-on <level>", "breaking | warning | any | never", "breaking")
  .option("--settle <ms>", "quiet period before reading tools", "400")
  .option("--timeout <ms>", "hard ceiling on the wait", "10000")
  .option("--executable-path <path>", "Chrome 151+ binary to use")
  .option("--no-headless", "run with a visible browser")
  .option("--json", "print the diff as JSON")
  .option("--markdown <file>", "also write a markdown report")
  .action(async (url: string, options) => {
    const baseline = await readSnapshot(options.baseline);
    const current = await run(() =>
      capture({
        url,
        settleMs: Number(options.settle),
        timeoutMs: Number(options.timeout),
        executablePath: options.executablePath,
        headless: options.headless,
      }),
    );
    await emit(diffSnapshots(baseline, current), url, options);
  });

program
  .command("audit")
  .argument("<target>", "page to load, or a saved snapshot file")
  .description("check whether agents can safely act here: reversibility, and schema enforcement")
  .option("--probe", "also call each tool with input its own schema forbids")
  .option("--probe-unsafe", "probe tools that are not declared readOnly (this really calls them)")
  .option("--fail-on <level>", "breaking | warning | any | never", "breaking")
  .option("--settle <ms>", "quiet period before reading tools", "400")
  .option("--timeout <ms>", "hard ceiling on the wait", "10000")
  .option("--executable-path <path>", "Chrome 151+ binary to use")
  .option("--no-headless", "run with a visible browser")
  .option("--json", "print findings as JSON")
  .option("--markdown <file>", "also write a markdown report")
  .action(async (target: string, options) => {
    const wantsProbe = Boolean(options.probe || options.probeUnsafe);
    let findings: Finding[];
    let label = target;

    if (!isUrl(target)) {
      if (wantsProbe) {
        fail("Probing needs a live page — pass a URL rather than a snapshot file.");
      }
      const snapshot = await readSnapshot(target);
      label = snapshot.url;
      findings = [
        ...auditReversibility(snapshot).findings,
        ...auditSafety(snapshot).findings,
      ];
    } else {
      findings = await run(async () =>
        withSession(
          {
            url: target,
            settleMs: Number(options.settle),
            timeoutMs: Number(options.timeout),
            executablePath: options.executablePath,
            headless: options.headless,
          },
          async (session) => {
            const collected = [
              ...auditReversibility(session.snapshot).findings,
              ...auditSafety(session.snapshot).findings,
            ];
            if (wantsProbe) {
              const probed = await probeConformance(session.tools, {
                includeUnsafe: Boolean(options.probeUnsafe),
              });
              collected.push(...probed.findings);
            }
            return collected;
          },
        ),
      );
    }

    await emit(summarize(findings), label, options);
  });

program
  .command("diff")
  .argument("<before>", "baseline snapshot file")
  .argument("<after>", "snapshot file to compare")
  .description("compare two recorded snapshots, no browser needed")
  .option("--fail-on <level>", "breaking | warning | any | never", "breaking")
  .option("--json", "print the diff as JSON")
  .option("--markdown <file>", "also write a markdown report")
  .action(async (beforePath: string, afterPath: string, options) => {
    const before = await readSnapshot(beforePath);
    const after = await readSnapshot(afterPath);
    await emit(diffSnapshots(before, after), after.url, options);
  });

interface EmitOptions {
  json?: boolean;
  markdown?: string;
  failOn: string;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function emit(result: DiffResult, url: string, options: EmitOptions): Promise<void> {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderConsole(result, url));
  }

  const markdown = renderMarkdown(result, url);
  if (options.markdown) await writeText(options.markdown, markdown);

  // Surface the same table in the workflow run when we're inside Actions.
  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary) await appendFile(stepSummary, markdown, "utf8");

  if (shouldFail(result, parseFailOn(options.failOn))) {
    console.error("\nContract check failed.");
    process.exitCode = 1;
  }
}

function parseFailOn(value: string): FailOn {
  if (value === "breaking" || value === "warning" || value === "any" || value === "never") {
    return value;
  }
  fail(`--fail-on must be breaking, warning, any, or never (got "${value}")`);
}

async function readSnapshot(path: string): Promise<Snapshot> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    fail(`No baseline at ${path}. Record one first:\n  sponsio snapshot <url> -o ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${path} is not valid JSON.`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Snapshot).sponsio !== 1 ||
    !Array.isArray((parsed as Snapshot).tools)
  ) {
    fail(`${path} is not a sponsio snapshot.`);
  }
  return parsed as Snapshot;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2) + "\n");
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, text, "utf8");
}

async function run<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof SponsioError) fail(error.message);
    throw error;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
