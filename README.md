# toolpact

**Contract testing for the tools your site exposes to AI agents.**

When your UI breaks, users complain. When the tools your site exposes to agents break, nothing happens — no error page, no support ticket. An AI shopping assistant just quietly fails to buy from you and buys somewhere else.

toolpact records the tools a page registers, commits that record to your repo, and fails the build when the contract changes underneath the agents already using it.

```bash
npx toolpact snapshot https://shop.example -o toolpact.baseline.json   # record
npx toolpact check    https://shop.example                             # enforce
```

```
search_products
  BREAKING pillar Allowed values removed: "toys". A tool call using one of these
                  now fails — often silently, as an empty result.
  BREAKING locale New required property. Agents that omit it will fail.
   WARNING        Description changed. The model selects tools by description, so
                  this can change behavior with no schema change.

4 breaking · 1 warning · 1 safe
```

## Why a baseline, and not a score

Plenty of tools will audit a page and hand you a number out of 100. A score tells you how you're doing today. It cannot tell you that **last Tuesday's deploy renamed an enum value and every agent that used it has been failing since** — that needs yesterday's contract, which is why toolpact keeps the baseline in your repo, next to the code that changed.

## The severity model

Every change is classified by what it does to an agent that was already calling your tools.

| | Meaning | Examples |
| --- | --- | --- |
| 🛑 **breaking** | A call that worked before now fails, or does something different | Tool removed · new required property · type changed · enum value removed · constraint tightened · `readOnly` or `consequential` hint lost |
| ⚠️ **warning** | The call still succeeds, but agent behavior may change | Description changed · parameter description changed · schema added or dropped · newly marked consequential |
| ✅ **safe** | Strictly more capability; nothing an existing caller relied on | New tool · new optional property · new enum value · constraint relaxed · property no longer required |

Two of these classifications are deliberate and worth explaining.

**Description changes are warnings, not cosmetic.** For a REST API, docs are documentation. For an agent, the description *is* the selection interface — reword it and the model may stop choosing the tool, with every schema byte identical. Most contract tools ignore prose. This one doesn't.

**Losing a safety hint is breaking.** A tool that drops `readOnly` now has side effects an agent was calling it speculatively without. A tool that drops `consequential` stops triggering the approval gates built on top of it. Nothing in the schema changed; the blast radius did.

## CI

```yaml
- uses: your-org/toolpact/action@v0
  with:
    url: https://shop.example
    fail-on: breaking
```

Exit code is `1` when the threshold is crossed. Inside GitHub Actions the markdown report is appended to the job summary automatically; use `--markdown report.md` to write it anywhere else.

```bash
toolpact check https://shop.example --fail-on warning     # stricter
toolpact check https://shop.example --json                # machine-readable
toolpact diff before.json after.json                      # offline, no browser
```

## Requirements

- **Node 20+**
- **Chrome 151+** — toolpact reads tools through Puppeteer's `page.webmcp`, backed by Chromium's WebMCP CDP domain. Install `puppeteer` alongside it, or pass `--executable-path` to point at your own Chrome.
- **A secure context.** WebMCP only initializes on `https` or `localhost`; plain http over a LAN address registers no tools at all, and toolpact will tell you so rather than reporting an empty contract.

```bash
npm install -D toolpact puppeteer
```

## How it captures

Tools register from page script at arbitrary times, so there is no "tools are ready" event. Chrome replays every already-registered tool when the WebMCP domain is enabled, which removes the startup race; toolpact then waits for a quiet period (`--settle`, default 400ms) with a hard ceiling (`--timeout`, default 10s) to catch late registrations. Declarative tools synthesized from annotated HTML forms are captured the same way and marked `declarative`.

## Programmatic use

```ts
import { capture, diffSnapshots, shouldFail } from "toolpact";

const current = await capture({ url: "https://shop.example" });
const result = diffSnapshots(baseline, current);

if (shouldFail(result, "breaking")) {
  console.error(result.findings.filter((f) => f.severity === "breaking"));
}
```

## Status

Early. The capture path tracks a spec that is still moving — WebMCP is a W3C Community Group draft in Chrome and Edge origin trials, and the API moved from `navigator.modelContext` to `document.modelContext` in Chrome 150. That churn is a large part of why this exists: a project shipped eight tools that registered nothing for three months because their tests mocked the browser API while the real root object moved.

Issues and integrations welcome, particularly captures from real sites with unusual registration patterns.

MIT
