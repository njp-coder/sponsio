import { summarize } from "./diff.js";
import { buildValidInput } from "./conformance.js";
import type { Session } from "./capture.js";
import type { DiffResult, Finding } from "./types.js";

/**
 * Does anything measure what agents do here?
 *
 * A tool call is a plain function call inside the page. It fires no page view,
 * no click, no form submission — so an agent that searches, adds to a cart and
 * checks out produces one page view and a conversion with no funnel behind it.
 * Neither the WebMCP spec nor Chrome's documentation mentions analytics at all,
 * and agentic browsers arrive on ordinary Chrome user agents that bot filters
 * cannot catch, so the traffic is invisible rather than merely mislabelled.
 *
 * This calls each safe tool and watches whether anything at all is recorded.
 */
export async function auditInstrumentation(
  session: Session,
  options: { includeUnsafe?: boolean } = {},
): Promise<DiffResult> {
  const findings: Finding[] = [];
  const candidates = session.tools.filter(
    (tool) => options.includeUnsafe || tool.annotations?.readOnly === true,
  );

  if (candidates.length === 0) return summarize(findings);

  await session.evaluate(INSTALL_PROBE);

  let observed = 0;
  const silent: string[] = [];

  for (const tool of candidates) {
    await session.evaluate("window.__sponsio.reset()");
    await tool.execute(buildValidInput(tool.inputSchema ?? {}));
    const events = await session.evaluate<number>("window.__sponsio.count()");
    if (events > 0) observed++;
    else silent.push(tool.name);
  }

  if (observed === 0) {
    findings.push({
      severity: "warning",
      code: "NO_AGENT_TELEMETRY",
      tool: "(page)",
      message:
        `None of the ${candidates.length} tool(s) called here emitted a browser-side ` +
        `analytics event, so agent conversions will arrive with no funnel behind them. ` +
        `Emit one inside execute(), and read \`SubmitEvent.agentInvoked\` on declarative ` +
        `forms. (If you record these server-side, this check cannot see it — ignore.)`,
    });
  } else if (silent.length > 0) {
    findings.push({
      severity: "warning",
      code: "PARTIAL_AGENT_TELEMETRY",
      tool: "(page)",
      message:
        `${observed} of ${candidates.length} tools emit a browser-side analytics event; ` +
        `${silent.join(", ")} emit none, so those steps are missing from any funnel ` +
        `built on them. Server-side tracking is invisible to this check.`,
    });
  }

  return summarize(findings);
}

/**
 * Wraps the three sinks that carry almost all client-side analytics. Kept as a
 * string because it is evaluated inside the page, not in this process.
 */
const INSTALL_PROBE = `(() => {
  if (window.__sponsio) return;
  let hits = 0;
  const bump = () => { hits++; };

  const layer = (window.dataLayer = window.dataLayer || []);
  const push = layer.push.bind(layer);
  layer.push = (...args) => { bump(); return push(...args); };

  const gtag = window.gtag;
  window.gtag = (...args) => { bump(); return gtag ? gtag(...args) : undefined; };

  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (...args) => { bump(); return beacon(...args); };
  }

  const fetchImpl = window.fetch ? window.fetch.bind(window) : undefined;
  if (fetchImpl) {
    window.fetch = (...args) => {
      const url = String(args[0] && args[0].url ? args[0].url : args[0] ?? "");
      if (/google-analytics|googletagmanager|segment|amplitude|mixpanel|posthog|plausible|matomo|heap|snowplow/i.test(url)) bump();
      return fetchImpl(...args);
    };
  }

  window.__sponsio = { count: () => hits, reset: () => { hits = 0; } };
})()`;
