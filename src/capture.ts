import type { JsonSchema, Snapshot, ToolAnnotations, ToolRecord } from "./types.js";

export interface CaptureOptions {
  url: string;
  /** Stop waiting once no tool has registered for this long. */
  settleMs?: number;
  /** Hard ceiling on the settle wait. */
  timeoutMs?: number;
  /** Path to a Chrome 151+ binary, if not using the bundled one. */
  executablePath?: string;
  headless?: boolean;
  /** Extra Chromium launch flags. */
  args?: string[];
}

const DEFAULTS = {
  settleMs: 400,
  timeoutMs: 10_000,
  headless: true,
};

/**
 * The one flag that matters: `chrome://flags/#enable-webmcp-testing` is exactly
 * `blink::features::kWebMCP`, so enabling the feature by name is equivalent and
 * needs no origin-trial token.
 */
export const WEBMCP_LAUNCH_ARGS = [
  "--enable-features=WebMCP",
  "--no-sandbox",
  "--disable-setuid-sandbox",
];

export interface InvocationResult {
  status: "Completed" | "Canceled" | "Error";
  output?: unknown;
  errorText?: string;
}

/** A captured tool that can still be called, for as long as the session is open. */
export interface LiveTool extends ToolRecord {
  execute(args: unknown): Promise<InvocationResult>;
}

export interface Session {
  snapshot: Snapshot;
  tools: LiveTool[];
}

/**
 * Load a page in Chrome and record every tool it exposes to agents.
 *
 * Registration happens in page script at arbitrary times, so there is no
 * "tools ready" signal. Chrome replays every already-registered tool when the
 * WebMCP CDP domain is enabled, which removes the startup race; the remaining
 * job is to wait for late registrations to stop arriving.
 */
export async function capture(options: CaptureOptions): Promise<Snapshot> {
  return withSession(options, async (session) => session.snapshot);
}

/**
 * Open a page, hand the caller its live tools, and tear the browser down
 * afterwards. Tools stay callable only inside `fn` — conformance probing needs
 * to invoke them, which a plain snapshot cannot support.
 */
export async function withSession<T>(
  options: CaptureOptions,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const settleMs = options.settleMs ?? DEFAULTS.settleMs;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;

  assertSecureContext(options.url);
  const puppeteer = await loadPuppeteer();

  const browser = await puppeteer.launch({
    headless: options.headless ?? DEFAULTS.headless,
    executablePath: options.executablePath,
    args: [...WEBMCP_LAUNCH_ARGS, ...(options.args ?? [])],
  });

  try {
    const page = await browser.newPage();
    const webmcp = (page as { webmcp?: PuppeteerWebMcp }).webmcp;
    if (!webmcp) {
      throw new SponsioError(
        "This Chrome build has no WebMCP support.\n" +
          "sponsio needs Chrome 151 or newer (Puppeteer's `page.webmcp`).\n" +
          "Pass --executable-path to point at a newer Chrome.",
      );
    }

    let lastChange = Date.now();
    const bump = () => {
      lastChange = Date.now();
    };
    webmcp.on("toolsadded", bump);
    webmcp.on("toolsremoved", bump);

    await page.goto(options.url, { waitUntil: "networkidle2", timeout: timeoutMs });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() - lastChange < settleMs && Date.now() < deadline) {
      await sleep(50);
    }

    const raw = webmcp.tools();
    const records = await Promise.all(raw.map(normalizeTool));
    const tools: LiveTool[] = records
      .map((record, index) => {
        const source = raw[index]!;
        return {
          ...record,
          execute: (args: unknown) => invoke(source, args),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const snapshot: Snapshot = {
      sponsio: 1,
      url: options.url,
      capturedAt: new Date().toISOString(),
      userAgent: await browser.version(),
      tools: tools.map(stripExecute),
    };

    return await fn({ snapshot, tools });
  } finally {
    await browser.close();
  }
}

async function invoke(source: RawTool, args: unknown): Promise<InvocationResult> {
  if (typeof source.execute !== "function") {
    return { status: "Error", errorText: "This build exposes no execute() for tools." };
  }
  try {
    const result = (await source.execute(args)) as InvocationResult | undefined;
    // Older builds resolve with a bare value rather than an invocation record.
    if (result && typeof result === "object" && "status" in result) return result;
    return { status: "Completed", output: result };
  } catch (error) {
    return { status: "Error", errorText: error instanceof Error ? error.message : String(error) };
  }
}

function stripExecute(tool: LiveTool): ToolRecord {
  const { execute: _execute, ...record } = tool;
  return record;
}

/**
 * The CDP payload and the page-script API disagree on annotation names, and a
 * declarative tool is only identifiable by carrying a backing form element.
 *
 * `formElement` is a prototype getter that always returns a promise, so the
 * property itself is never undefined — only the resolved value distinguishes a
 * form-backed tool from an imperative one.
 */
async function normalizeTool(raw: RawTool): Promise<ToolRecord> {
  const annotations = normalizeAnnotations(raw.annotations);
  return {
    name: raw.name,
    description: raw.description ?? "",
    inputSchema: raw.inputSchema as JsonSchema | undefined,
    ...(annotations ? { annotations } : {}),
    kind: (await hasFormElement(raw)) ? "declarative" : "imperative",
  };
}

async function hasFormElement(raw: RawTool): Promise<boolean> {
  if (raw.backendNodeId !== undefined) return true;
  try {
    return (await raw.formElement) != null;
  } catch {
    return false;
  }
}

function normalizeAnnotations(raw: RawAnnotations | undefined): ToolAnnotations | undefined {
  if (!raw) return undefined;
  const out: ToolAnnotations = {};
  const readOnly = raw.readOnly ?? raw.readOnlyHint;
  const untrusted = raw.untrustedContent ?? raw.untrustedContentHint;
  const consequential = raw.consequential ?? raw.consequentialHint;
  if (readOnly !== undefined) out.readOnly = readOnly;
  if (untrusted !== undefined) out.untrustedContent = untrusted;
  if (consequential !== undefined) out.consequential = consequential;
  if (raw.autosubmit !== undefined) out.autosubmit = raw.autosubmit;
  return Object.keys(out).length ? out : undefined;
}

/** WebMCP is gated on a secure context, so plain http on a LAN address exposes nothing. */
function assertSecureContext(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SponsioError(`Not a valid URL: ${url}`);
  }
  const host = parsed.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new SponsioError(
      `WebMCP only runs in a secure context, so ${url} will register no tools.\n` +
        "Use https, or serve on localhost.",
    );
  }
}

async function loadPuppeteer(): Promise<PuppeteerModule> {
  // Indirect specifier: puppeteer is an optional peer dependency, so it must not
  // be resolved at build time.
  const specifier = "puppeteer";
  try {
    return (await import(specifier)) as unknown as PuppeteerModule;
  } catch {
    throw new SponsioError(
      "puppeteer is required to capture from a live page.\n  npm install puppeteer",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SponsioError extends Error {
  override name = "SponsioError";
}

// Minimal structural types for the bits of Puppeteer we touch, so the package
// builds without puppeteer installed.
interface RawAnnotations {
  readOnly?: boolean;
  readOnlyHint?: boolean;
  untrustedContent?: boolean;
  untrustedContentHint?: boolean;
  consequential?: boolean;
  consequentialHint?: boolean;
  autosubmit?: boolean;
}

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: RawAnnotations;
  backendNodeId?: number;
  /** Prototype getter: always a promise, resolving to null for imperative tools. */
  formElement?: Promise<unknown> | unknown;
  execute?: (args: unknown) => Promise<unknown>;
}

interface PuppeteerWebMcp {
  tools(): RawTool[];
  on(event: "toolsadded" | "toolsremoved", handler: () => void): void;
}

interface PuppeteerModule {
  launch(options: {
    headless?: boolean;
    executablePath?: string;
    args?: string[];
  }): Promise<{
    newPage(): Promise<{
      goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
      webmcp?: PuppeteerWebMcp;
    }>;
    version(): Promise<string>;
    close(): Promise<void>;
  }>;
}
