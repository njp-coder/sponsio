# sponsio

**Contract testing for the tools your site exposes to AI agents.**

When your UI breaks, users complain. When the tools your site exposes to agents break, nothing happens — no error page, no support ticket. An AI shopping assistant just quietly fails to buy from you and buys somewhere else.

sponsio records the tools a page registers, commits that record to your repo, and fails the build when the contract changes underneath the agents already using it.

```bash
npx sponsio snapshot https://shop.example -o sponsio.baseline.json   # record
npx sponsio check    https://shop.example                             # enforce
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

Plenty of tools will audit a page and hand you a number out of 100. A score tells you how you're doing today. It cannot tell you that **last Tuesday's deploy renamed an enum value and every agent that used it has been failing since** — that needs yesterday's contract, which is why sponsio keeps the baseline in your repo, next to the code that changed.

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

## Can agents safely act here?

Diffing tells you what changed. `audit` tells you whether the surface was safe in the first place — no baseline needed.

```bash
npx sponsio audit https://shop.example
```

```
charge_card
  BREAKING Consequential action with no inverse. An agent can commit this and
           has no tool to undo it. Expose a `refund_card` tool.
  BREAKING Consequential action with no idempotency key in its schema. Agents
           retry failed writes the way they retry reads, so this will
           eventually run twice.
  BREAKING card_number Schema asks the agent for raw card details. A model
           should never be handed this — take a payment token from a hosted
           field, never the number itself.
   WARNING The effect leaves your system the moment it runs...
```

Four checks, each from a way agents actually fail:

**Reversibility.** Every action an agent can take is matched against the tools that could undo it. A scan of live WebMCP sites found 97% of those that let an agent commit a purchase exposed no cancel, refund, or undo tool at all. `create_order` looks for `cancel_order`; `add_to_cart` looks for `remove_from_cart`; a general `undo` covers everything.

**Idempotency.** Agents retry a failed write exactly the way they retry a read — the frameworks do it for you, and a timeout is indistinguishable from a failure. A consequential tool with no idempotency key in its schema will eventually run twice.

**Sensitive parameters.** Whatever a schema asks for, the model will try to supply, from its context or by asking the user in chat. A tool whose schema takes a card number, CVV, password, or government ID is routing that data through a language model.

**Effect escape.** Some actions have an inverse that doesn't actually undo them. A recalled message may already have been read; a refunded charge still moved money. Structural reversibility and real reversibility are different things, and only the first is visible in a schema.

### Probing: does a tool honor its own schema?

`inputSchema` is advisory. The browser hands it to the agent as guidance and validates nothing, and an independent scan found **78% of probes were accepted despite violating the tool's own declared schema** — on Google's own reference demos. So testing the declaration alone tests a document, not a system.

```bash
npx sponsio audit https://shop.example --probe
```

This calls each tool with input its schema forbids — a missing required field, a value outside an enum, a number past its maximum — and reports what gets accepted. Because probing really invokes tools, anything not declared `readOnly` is skipped unless you pass `--probe-unsafe`.

## CI

```yaml
- uses: your-org/sponsio/action@v0
  with:
    url: https://shop.example
    fail-on: breaking
```

Exit code is `1` when the threshold is crossed. Inside GitHub Actions the markdown report is appended to the job summary automatically; use `--markdown report.md` to write it anywhere else.

```bash
sponsio check https://shop.example --fail-on warning     # stricter
sponsio check https://shop.example --json                # machine-readable
sponsio diff before.json after.json                      # offline, no browser
```

## Requirements

- **Node 20+**
- **Chrome 151+** — sponsio reads tools through Puppeteer's `page.webmcp`, backed by Chromium's WebMCP CDP domain. Install `puppeteer` alongside it, or pass `--executable-path` to point at your own Chrome.
- **A secure context.** WebMCP only initializes on `https` or `localhost`; plain http over a LAN address registers no tools at all, and sponsio will tell you so rather than reporting an empty contract.

```bash
npm install -D sponsio puppeteer
```

## How it captures

Tools register from page script at arbitrary times, so there is no "tools are ready" event. Chrome replays every already-registered tool when the WebMCP domain is enabled, which removes the startup race; sponsio then waits for a quiet period (`--settle`, default 400ms) with a hard ceiling (`--timeout`, default 10s) to catch late registrations. Declarative tools synthesized from annotated HTML forms are captured the same way and marked `declarative`.

## Programmatic use

```ts
import { capture, diffSnapshots, shouldFail } from "sponsio";

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
