# Who to reach

## The central problem, stated plainly

There are two audiences, and only one of them knows it has a problem.

The **large** audience is Shopify merchants auto-enrolled into WebMCP in
August. Numerically enormous, genuinely affected, and almost entirely unaware —
they have never heard of WebMCP and cannot want a tool for a thing they do not
know exists. Marketing to them means first teaching a standard, which is a
content strategy measured in months, not a launch.

The **small** audience is developers who already know what WebMCP is because
they implemented it, argued about it, or built something adjacent during the
hackathon wave. A few thousand people worldwide. They need no education, they
will understand the value in one sentence, and several of them are already
looking for exactly this.

**Launch at the small one.** Use the large one as the story that makes the
market feel big — never as the target of outreach.

---

## sponsio — ICP tiers

### Tier 1: people who have already written WebMCP tools
The only group with the problem *today* and the vocabulary to recognise it.

- **Who:** developers who registered tools during the origin trial, entered the
  OpenAI WebMCP Challenge, filed or commented on spec issues, or published a
  WebMCP package.
- **Where they are, concretely:** the `webmachinelearning/webmcp` issue threads
  (especially #85 and #186 on lifecycle events and measurement); GitHub repos
  created since August mentioning webmcp; the hackathon submissions; the
  MCP-B / WebMCP-org community; Hacker News threads on the standard.
- **What they already feel:** that their tools break silently, that they have
  no way to know if anything actually registered, that the spec keeps moving
  under them.
- **The opener that works:** the honest-origin story. They know the field is
  crowded; acknowledging it first is what buys the next paragraph.

### Tier 2: Shopify app developers and e-commerce agencies
The bridge to the large audience — technical enough to care, close enough to
merchants to act on their behalf.

- **Who:** developers building Shopify apps or themes, and agencies running
  storefronts for clients.
- **Where:** Shopify dev community, Shopify Partners channels, r/shopify's dev
  discussions, agency newsletters.
- **What they feel:** responsibility for stores they did not fully configure,
  and unease about a platform feature they were opted into.
- **The opener:** the Shopify surprise — *your clients' stores now expose agent
  tools nobody wrote; here is what they expose.*
- **Caution:** r/shopify is hostile to promotion. Post there only as a genuine
  participant, and lead with the finding rather than the tool.

### Tier 3: the agentic-web curious
Will not convert to usage soon, but supply the stars, the reposts, and the
early credibility that makes tiers 1 and 2 take you seriously.

- **Who:** developers following agent infrastructure, AI-adjacent engineers,
  the HN front page audience.
- **Where:** Hacker News, X, dev newsletters.
- **The opener:** the silent-failure angle, or the 97% statistic.

### Explicitly not the ICP, for now
Non-technical merchants; enterprise security buyers (that is a different
product and a nine-month sale); marketers (they are agentpixel's audience, and
only later).

---

## agentpixel — ICP tiers

The honest position: this product's ICP barely exists yet, and that is a timing
problem rather than a product problem. Nobody buys measurement for traffic they
do not yet have. Ship it, keep it free, let it wait for its market.

### Tier 1: people who just ran sponsio and saw the finding
The only pre-qualified audience in existence. They have tools, they have run an
audit, and they have been told in their own terminal that none of those tools
record anything.

- **Where:** they came from sponsio. This is the entire argument for launching
  the two a week apart rather than together.
- **The opener:** *you saw the finding; here is the one-line fix.*

### Tier 2: growth and analytics engineers at agent-exposed commerce
Real buyers, but only once agent traffic is large enough to distort a report
they actually read.

- **Who:** the person who owns GA4 or the data layer at a store with real
  agent-driven orders.
- **Where:** r/GoogleAnalytics and r/analytics, the Measure community, analytics
  newsletters.
- **What they feel:** conversions they cannot attribute, direct traffic that
  makes no sense, an uneasy sense that their bot filtering is wrong.
- **The opener:** the funnel-with-no-middle, or the bot-filter-deletes-buyers
  framing.
- **Timing:** revisit when Gemini in Chrome consumes tools broadly. Until then
  the honest answer to "should I install this" is "only if you already have
  agent traffic."

### Tier 3: the four other people building WebMCP instrumentation
Not customers. Worth reaching anyway, because in a field this small the other
builders are the distribution.

- **Where:** the autotel repo, the spec issues, the awesome-webmcp lists.
- **The move:** contribute an analytics adapter upstream, comment substantively
  on spec issue #186, credit them publicly. Costs an afternoon and buys standing
  that no amount of posting will.

---

## What to do first, concretely

1. Find and read the fifteen most recent WebMCP repos created since August. Run
   sponsio against every demo they ship. Where it finds something real, open an
   issue that reports the finding and mentions the tool second.
2. Comment on spec issue #186 with what capturing twice actually taught you
   about silent registration failure. That thread is where the people who
   matter already are.
3. Post the Show HN with the honest-origin angle, on a weekday morning US
   Eastern, and be present all day. The comments are the launch.
4. Only then approach Shopify-adjacent developers, with a finding from a real
   store rather than a pitch.
