# Write-ups — every length, both products

Ordered short to long. The long ones teach the concept first, because almost
nobody knows what WebMCP is yet and a pitch that assumes they do will lose them
in the first sentence.

---

# sponsio

## One-liner (npm description, GitHub tagline)

Contract testing for the tools your site exposes to AI agents.

## Tweet-length

Your UI breaks and users complain. The tools your site exposes to AI agents
break and nobody says anything — the agent just fails quietly and buys
somewhere else. sponsio catches that in CI.

## Paragraph (README opener, HN first para)

Websites are starting to expose "tools" to AI agents — a shop might publish
`search_products`, `add_to_cart`, `checkout` — and agents call them directly
instead of clicking buttons. Those definitions are a promise to every agent
using them, and promises break silently on every deploy: no error page, no
support ticket, no bug report. sponsio loads your page in a real Chrome,
records the tools it exposes, commits that record to your repo, and fails the
build when the contract changes underneath the agents already relying on it.

## The full explanation — for someone who has never heard of WebMCP

For thirty years the web had one interface: a human, looking at pixels,
clicking things. Every tool we built for measuring or testing the web assumed
that human.

That assumption is now breaking. AI agents increasingly act on websites on
someone's behalf — booking, buying, filling forms. Until recently they did it
by looking at the page and guessing which button to click, which is slow,
fragile, and something sites hate.

WebMCP is the fix the browser makers agreed on. It is a standard, written by
Google and Microsoft engineers, that lets a site say to agents, in code: here
are the things you can do here, properly. A shop declares `add_to_cart` with a
schema, and an agent calls it directly instead of hunting for a button. Think
of it as a reception desk for robots: rather than wandering the building trying
doors, they are handed a menu of services.

This is not hypothetical. Chrome ships it behind an origin trial, ChatGPT's
desktop app consumes it, and in August Shopify switched it on for every Liquid
storefront — so a very large number of stores now expose agent tools their
owners never wrote and have never looked at.

Here is the problem. Those tool definitions change every time you deploy, and
when they break, nothing tells you. There is no error page, because no human
saw one. There is no support ticket, because the customer never knew. An AI
shopping assistant simply fails to buy from you and buys from a competitor.
Worse, the failure is often invisible even to the agent: rename one category
value and the call still returns HTTP 200 with an empty list, so the agent
reports success and moves on.

sponsio does two things about that.

First, contract testing. It loads your page in a real Chrome, records every
tool you expose along with its schema, and stores that record in your git
repository next to the code that produced it. On every deploy it captures again
and compares, classifying each change by what it does to an agent already
calling you: breaking, warning, or safe. Removing an enum value is breaking.
Adding an optional field is safe. Changing a tool's description is a warning —
because for a language model the description is not documentation, it is the
interface it selects on, and rewording it can stop the model choosing your tool
with every byte of schema identical.

Second, a safety audit that needs no baseline at all. It asks whether agents
can act safely on your site in the first place, and it asks in ways drawn from
how agents actually fail. Can this action be undone, or has the agent walked
through a one-way door? A scan of live sites found that 97% of those letting an
agent commit a purchase exposed no cancel, refund or undo tool. Does this
payment accept an idempotency key — because agents retry failed writes exactly
the way they retry reads, so eventually it runs twice and someone is charged
twice. Is your schema asking a language model for a card number, a password, or
a national identity number. Does this amount have a maximum, or can one
confused call cost anything at all.

It also looks twice, once with the API forced on and once as a plain browser,
because the most expensive failure in this whole standard leaves no trace: if
your origin-trial token lapses, `document.modelContext` disappears and every
tool registration becomes a silent no-op. The site looks perfect to every human
who visits and exposes nothing to every agent. One team shipped in that state
for three months.

---

# agentpixel

## One-liner

The pixel for AI agent traffic.

## Tweet-length

An agent searched your catalog, added to cart, and checked out. Your analytics
recorded one pageview and a conversion with nothing in between. agentpixel puts
agent tool calls into GA4, GTM, PostHog or Segment in one line.

## Paragraph

A WebMCP tool call is a plain function call inside your page. It fires no page
view, no click, no form submission — so an agent that searches, adds to a cart
and checks out leaves you a conversion with no funnel behind it. Neither the
spec nor Chrome's documentation mentions measurement anywhere, and agentic
browsers arrive on ordinary Chrome user agents that bot filters structurally
cannot catch. agentpixel is one line of setup that sends every agent tool call
to the analytics you already run.

## The full explanation

We spent twenty-five years building an industry to count clicks and pageviews.
Every analytics product assumes a human moving a cursor.

Agents do not move a cursor. When a site exposes tools through WebMCP, an agent
calls them as functions. No click event fires. No form submits. No page
navigates. Your analytics sees the page load and then, some seconds later, a
conversion — with nothing in between to explain it.

It is worse than merely missing. Agentic browsers present ordinary Chrome user
agents with no distinguishing token, and GA4's bot filtering works from a
self-declared list, so it cannot catch them even in principle. Some of these
browsers ship ad blockers that kill your tag manager outright; others auto-decline
consent banners and strip referrers, so the sessions that do land arrive as
direct traffic with inflated new-user counts. As one analyst put it: every
analytics team should assume its bot rules are currently deleting buyers.

agentpixel closes that in one line. It wraps tool registration, times every
call, records whether it succeeded, and pushes an `agent_tool_call` event into
GA4, GTM, PostHog, Segment or Mixpanel — whichever you already have. Adapters
are no-ops when their vendor is absent, so shipping one you have not installed
costs nothing.

It also covers the half that other instrumentation misses. There are two kinds
of WebMCP tool: imperative ones registered in JavaScript, and declarative ones
the browser synthesizes from annotated HTML forms. Every existing library wraps
only the first. But the browser sets a read-only `agentInvoked` flag on form
submissions — the single agent signal a site gets for free — and since Shopify
and Cloudflare auto-generate mostly declarative tools, for a great many sites
that missing half is the entire surface.

By default it records the shape of arguments rather than their contents:
`{ query: "string[9]" }`, not what was searched for. Safe to install without a
privacy review. Passwords, tokens, cards and identity numbers are redacted
automatically if you opt into values.
