# Story angles

Six for sponsio, four for agentpixel, ranked by how well each travels. Pick one
per channel — a post that tries two lands neither.

---

# sponsio

## 1. The silent failure — the default, works everywhere

> Your UI breaks and users complain. The tools your site exposes to AI agents
> break and nobody says anything.

The whole product in two sentences, and it needs no knowledge of WebMCP to
land. The kicker is that the failure is invisible to the agent too: rename one
enum value and the call still returns 200 with an empty list, so the agent
reports success. Nobody finds out until revenue dips.

**Best for:** README, npm description, LinkedIn, the X hook.

## 2. Somebody's schema is asking a language model for a CVV — the visceral one

Real finding from a real run. It reframes the product from "linting" to
"someone is about to do something genuinely unsafe," and it is the one an
engineer forwards to a colleague.

**Best for:** X (screenshot the terminal), the video's punch-in moment.
**Caution:** it is a finding from our own demo fixture. Never imply it was
found on a named third-party site.

## 3. The honest origin — the HN-native one

> I set out to build a WebMCP CI tool. Then I found that about twenty people
> had the same idea in the previous two weeks, and nearly dropped it. What
> changed my mind: every one of them was checking whether the schema had
> changed. Not one was asking whether an agent could safely act on the site at
> all.

Hacker News rewards this kind of honesty more than any other audience, and it
pre-empts the "isn't this just X?" comment by raising it yourself in paragraph
one. It also happens to be true.

**Best for:** Show HN body. **Do not** use elsewhere — it is a comment-section
story, not a headline.

## 4. The one-way door — the strongest number

> 97% of sites that let an agent commit a purchase expose no way to cancel it.

Not our research — an independent scan of 475 live sites. Cite it as theirs.
It is the most quotable statistic in the space and it makes the reversibility
check the headline feature rather than a bullet.

**Best for:** X thread opener, LinkedIn, any talk.
**Caution:** attribute it. Passing someone else's scan off as ours is the one
mistake that would actually cost credibility.

## 5. The site that went quiet — the eeriest

> Your origin-trial token lapsed. `document.modelContext` is gone. Every
> registration is now a silent no-op. The site looks perfect to every human and
> exposes nothing to any agent — and it can stay that way for months.

This is the failure only sponsio finds, because it captures twice. Best used as
the "and here's the one you'd never catch by hand" beat after another angle has
already landed.

**Best for:** the second half of a thread, or the Show HN "technically
interesting" paragraph.

## 6. The Shopify surprise — biggest audience, weakest intent

> In August, Shopify switched WebMCP on for every Liquid storefront. Your store
> has agent tools you never wrote. Do you know what they expose?

Numerically the largest audience by far. But the merchant who owns that store
has never heard of WebMCP and does not know they have a problem, so this is a
story that makes the market feel big — not a message that converts.

**Best for:** framing in a post, press, and investor conversation.
**Not for:** cold outreach to merchants. See ICP.md.

---

# agentpixel

## 1. The conversion with no funnel — the default

> An agent searched your catalog, added to cart, and checked out. Your
> analytics recorded one pageview, then a conversion, and nothing in between.

Instantly legible to anyone who has ever looked at a funnel report.

## 2. Your bot filter is deleting buyers

> Agentic browsers arrive as ordinary Chrome. GA4's bot filtering works off a
> self-declared list, so it cannot catch them even in principle — and the
> traffic it does catch, it removes. Some of those sessions were carrying
> customers.

Sharper and more alarming than angle 1, for an analytics audience specifically.
Borrowed framing — credit the analyst who put it best rather than claiming it.

## 3. Everyone instruments half of it

> There are two kinds of WebMCP tool. Every existing library wraps one of them.
> The other kind is what Shopify and Cloudflare generate automatically.

The differentiator angle, for the four other people building in this space.
Pair it with genuine credit to `autotel-webmcp`, which does the OpenTelemetry
half well.

## 4. "Why track bot traffic? They don't have money." — the rebuttal

The actual objection, quoted from a real thread. Answer: Shopify reports
AI-originated orders growing several multiples year over year, with new-buyer
rates roughly double traditional channels. The bot is carrying a customer.

**Best for:** the reply you already have written when someone says it.

---

# Lines to never use

- **Anything conflating agent traffic with card-testing or scraper bots.**
  Merchants feel that pain far more acutely, the threads about it are much
  louder, and an informed reader will spot the conflation immediately and
  discount everything else.
- **A/B test contamination.** Plausible, widely asserted by vendors, and
  entirely unevidenced by practitioners. Do not claim it.
- **Any legal-exposure argument from Amazon v. Perplexity.** The injunction was
  vacated in August. Citing it dates the post and invites a correction.
- **Overstating adoption.** WebMCP demand is early; supply was switched on by
  platforms. Say so plainly — it is more credible and it is the actual reason
  the tools exist before the users do.
