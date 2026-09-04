# Message hierarchy

Everything else in this folder is these lines in a channel's dialect. If an artifact
contradicts them, the artifact is wrong.

## sponsio — launches first

1. **Headline benefit:** Catch the deploy that broke your AI agents.
2. **Mechanism:** Loads your page in real Chrome, records the tools it exposes to agents,
   diffs them against a baseline committed to your repo, and fails CI when the contract
   breaks. Then audits whether agents can act safely at all.
3. **Proof:** Rename one enum value and the agent's call still returns 200 — with an empty
   list. It reports success. Nobody finds out until sales dip. Also: a scan of 475 live
   sites found 97% of those letting an agent commit a purchase expose no way to cancel it.
4. **The ask:** Run it against your site and tell me what it gets wrong.

## agentpixel — launches second, one to two weeks later

1. **Headline benefit:** See AI agent activity in the analytics you already use.
2. **Mechanism:** Wraps `registerTool` and reads the browser's `agentInvoked` flag on
   forms, then pushes an `agent_tool_call` event to GA4, GTM, PostHog, Segment or Mixpanel.
3. **Proof:** A tool call fires no page view, no click, no form submission. An agent that
   searches, adds to a cart and checks out leaves you one page view and a conversion with
   nothing behind it.
4. **The ask:** Install it and tell me what your agent traffic actually looks like.

## Why sequenced, not simultaneous

sponsio's audit produces the finding — *none of your tools emit any telemetry* — that
agentpixel answers. Launching them together buries the second one and blunts the first.
Launched a week apart, the follow-up arrives with evidence people have already seen in
their own terminal.
