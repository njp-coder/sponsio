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

**Visibility.** sponsio looks twice: once with WebMCP forced on, to read what you *intend* to expose, and once as a stock browser, to see what a visitor's agent actually finds. A site whose origin-trial token has lapsed looks perfectly healthy in the first pass and exposes nothing in the second. Nothing errors — the site just goes quiet. One team shipped in that state for three months.

**Effect escape.** Some actions have an inverse that doesn't actually undo them. A recalled message may already have been read; a refunded charge still moved money. Structural reversibility and real reversibility are different things, and only the first is visible in a schema.

### Does every tool actually work?

The diff catches a contract that changed and the audit catches a surface that is unsafe. Neither notices a tool that is registered, correctly shaped, identical to its baseline, and simply broken.

```bash
npx sponsio audit https://shop.example --smoke --fixtures sponsio.fixtures.json
```

```
  ✓ add_to_cart           1ms  fixture
  ✓ search_products       0ms  fixture
  ✗ subscribe_newsletter
      The site has a programming error: it called preventDefault() on the
      'submit' event, without also calling respondWith() with the tool result

  2/3 tools responded
```

Give it real arguments and the check means something:

```json
{ "search_products": { "query": "cast iron" },
  "add_to_cart": { "product_id": "p1", "quantity": 2 } }
```

Generated arguments satisfy your *schema* but not your *world* — a made-up product id is supposed to be rejected — so a rejection without a fixture is only a warning, while a rejection of arguments **you** supplied is breaking. Writing a fixture for a tool also opts it in to being called even when it is not `readOnly`, since typing real arguments for it says plainly that you want it run.

This proves your tools respond. It does not prove they do the right thing.

### Probing: does a tool honor its own schema?

`inputSchema` is advisory. The browser hands it to the agent as guidance and validates nothing, and an independent scan found **78% of probes were accepted despite violating the tool's own declared schema** — on Google's own reference demos. So testing the declaration alone tests a document, not a system.

```bash
npx sponsio audit https://shop.example --probe
```

This calls each tool with input its schema forbids — a missing required field, a value outside an enum, a number past its maximum — and reports what gets accepted. Because probing really invokes tools, anything not declared `readOnly` is skipped unless you pass `--probe-unsafe`.

### Does anything stop an agent calling it in a loop?

Agents retry on error by default — every framework does it for you. A human clicking a button is self-limiting; an agent is not. The most-read agent incident of the year was an operator waking to a $6,531 bill after one retried a failing action all night.

Rate limiting cannot be read off a schema, because WebMCP has no field for it. So sponsio measures the behavior instead:

```bash
npx sponsio audit https://shop.example --burst 20
```

Each tool is called rapidly and watched for rejections or for the site deliberately slowing down. No throttle in either form is a warning. This is opt-in and off by default — it generates real load, and it only touches `readOnly` tools unless you pass `--probe-unsafe`.

**On cost, honestly: there is nothing to check.** WebMCP has no way for a tool to declare what a call costs — in money, credits, or quota — so an agent consuming a paid service has no price signal at all and cannot budget. That is a gap in the standard rather than something a linter can find, and it is worth raising with the working group rather than guessing at it here.

### Is anyone measuring what agents do?

A tool call is a plain function call in the page. It fires no page view, no click, no form submission — so an agent that searches, adds to a cart and checks out leaves you one page view and a conversion with no funnel behind it. Neither the WebMCP spec nor Chrome's docs mention analytics anywhere, and agentic browsers arrive on ordinary Chrome user agents that bot filters cannot catch, so this traffic is invisible rather than merely mislabelled.

With `--probe`, sponsio calls each tool and watches whether anything is recorded — `dataLayer`, `gtag`, `sendBeacon`, or a request to a known analytics endpoint — and tells you which of your tools are silent.

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

## Making agent activity visible

The audit tells you when none of your tools emit any telemetry. [`agentpixel`](https://github.com/agentpixel/agentpixel) is the fix — a zero-dependency browser shim that sends every agent tool call to the analytics you already run (GA4, GTM, PostHog, Segment, Mixpanel), covering both imperative tools and the declarative form tools most instrumentation misses.

```js
import { instrument, dataLayer } from "agentpixel";
instrument({ sinks: [dataLayer()] });
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
