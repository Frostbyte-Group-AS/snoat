import type { Article } from "./types";

export const vercelPricingAlternative: Article = {
  slug: "vercel-pricing-alternative",
  lang: "en",
  title: "Where a usage-based hosting bill comes from — and how to make it predictable",
  metaTitle: "Predictable Hosting Pricing vs Usage Billing | Snoat",
  description:
    "Usage-based hosting bills scale with traffic, not with value. Here are the meters that move the number, how to audit yours, and what a fixed-resource plan changes.",
  keywords: [
    "vercel pricing alternative",
    "vercel bandwidth cost",
    "predictable hosting pricing",
    "usage based billing hosting",
    "cheaper vercel alternative",
    "hosting cost optimisation",
  ],
  category: "comparison",
  published: "2026-08-20",
  related: [
    "vercel-alternative-europe",
    "european-paas-comparison",
    "deploy-nextjs-without-vercel",
  ],
  lead: "Nobody leaves a platform because the base price is too high. They leave because the bill moved and nobody could explain why. Usage-based pricing is not a trick — it is a fair way to sell capacity — but it does mean your hosting cost is a function of traffic, and traffic is the one variable you were hoping to increase. This article is about the meters, not about anyone's price list.",
  body: [
    {
      type: "note",
      title: "No competitor prices here, on purpose",
      text: "Published prices change, and an article quoting them is wrong within months. What does not change is which meters exist and how they behave. Take the list below to your current provider's pricing page and fill in the numbers yourself — that comparison stays valid.",
    },
    { type: "h2", text: "The five meters that actually move the number" },
    {
      type: "list",
      ordered: true,
      items: [
        "**Data transfer out.** Charged per gigabyte leaving the platform. It scales with visitors × page weight, so an unoptimised hero image is a line item, not a nitpick.",
        "**Function invocations and duration.** Charged per call and per GB-second. Server-rendered pages, API routes and middleware all count, and middleware often runs on every request including assets.",
        "**Image optimisation.** Charged per source image or per transformation. A responsive `srcset` with six widths and two formats is twelve variants of one photo.",
        "**Cache reads and writes.** Incremental regeneration and data caches are metered on some platforms — a high-traffic page that revalidates aggressively can generate a surprising amount of both.",
        "**Seats.** Charged per team member per month, independent of traffic. This is the one that grows when you hire, not when you succeed.",
      ],
    },
    {
      type: "p",
      text: "Two structural details matter as much as the rates. First, whether overages are billed or capped: billed overages protect uptime and expose you to a spike, caps do the reverse. Second, whether anything in the platform's request path counts as an invocation — a redirect, a bot hit, a health check and a scraper all bill the same as a real reader.",
    },
    { type: "h2", text: "How to audit your own bill in an hour" },
    {
      type: "list",
      ordered: true,
      items: [
        "Pull the last three invoices and write down every line item that is not the base plan. That list is your actual cost model.",
        "Divide data transfer by sessions to get bytes per session. Anything above a couple of megabytes for a content site is an optimisation project with a known payback.",
        "Check what share of invocations are static assets, redirects or bots. If a meaningful share is not a human reading a page, you are paying for traffic that will never convert.",
        "Find your most-revalidated page. Cache configuration is usually where a small change moves a big number.",
        "Count seats against people who actually deploy this month.",
      ],
    },
    {
      type: "p",
      text: "Most teams find at least one of: an unoptimised image pipeline, middleware running on asset requests, or a revalidation interval set to a number somebody typed once. Those are worth fixing regardless of who hosts you.",
    },
    { type: "h2", text: "What a fixed-resource plan changes" },
    {
      type: "p",
      text: "Snoat sells capacity rather than events. A plan gives you a number of concurrently running apps, memory and CPU per app, build memory, build minutes and queue priority. The price is the same in a quiet month and in a launch month, because the meter is the container you reserved and not the requests that reached it.",
    },
    {
      type: "table",
      caption: "The Snoat plans, excluding VAT",
      head: ["", "Free", "Pro", "Business"],
      rows: [
        ["Price (Norway)", "0", "199 kr/mo", "799 kr/mo"],
        ["Price (elsewhere)", "0", "€19/mo", "€79/mo"],
        ["Concurrent dynamic apps", "1", "10", "20"],
        ["Preview sites", "–", "5", "10"],
        ["Memory per running app", "256 MB", "2 GB", "8 GB"],
        ["Memory during build", "1 GB", "4 GB", "8 GB"],
        ["vCPU per app", "0.5", "2", "4"],
        ["Build minutes per month", "100", "500", "2 000"],
        ["Static sites", "Unlimited", "Unlimited", "Unlimited"],
      ],
    },
    {
      type: "p",
      text: "Three things are worth saying precisely about that table. Static sites do not run a container — the build output is served directly by our proxy — so they do not count against the app limit on any plan. Preview sites run at half the memory of a production app and have their own limit rather than consuming a production slot. And build memory is a separate number from runtime memory on purpose: `next build` holds the whole module graph in memory, while the finished server serves finished files.",
    },
    { type: "h3", text: "Bandwidth: what we say instead of a number" },
    {
      type: "p",
      text: "There is no gigabyte allowance in the plans, and there is no per-gigabyte charge either. The honest reason is that we do not meter it today, and a limit we cannot measure is a limit we cannot enforce — so the pricing page says fair use rather than inventing a ceiling. If your traffic becomes an outlier we will have a conversation with you before anything changes, and we would rather write that down than let you discover a policy after the fact.",
    },
    { type: "h2", text: "When usage-based billing is the better deal" },
    {
      type: "p",
      text: "It genuinely often is, and pretending otherwise would be a bad argument. If your traffic is spiky and low on average, paying per request is cheaper than reserving capacity for the peak. If you need to serve every continent with single-digit latency, a global edge network is the product and its pricing follows its cost. And if your team is small and stays on a free tier, free is hard to beat.",
    },
    {
      type: "p",
      text: "Fixed-resource pricing wins when your traffic is steady, when your audience is regional, when the bill needs to be a line in a budget approved a year in advance, or when the finance conversation about hosting has become a recurring meeting.",
    },
    {
      type: "faq",
      items: [
        {
          q: "Is Snoat cheaper than Vercel?",
          a: "It depends entirely on your traffic shape, and anyone who answers that with a flat yes is guessing. What is different is the shape of the bill: a fixed monthly price for reserved capacity, with no per-gigabyte or per-invocation component. Run the audit above on your last three invoices and the comparison takes ten minutes.",
        },
        {
          q: "Do you charge per team member?",
          a: "There is no per-seat component in the plans today. The plan limits are about running capacity — apps, memory, CPU, build minutes.",
        },
        {
          q: "What happens if I exceed the build minutes?",
          a: "Builds are queued and the limit applies to new builds, not to apps that are already running. An app that is up stays up.",
        },
        {
          q: "What if I need more than the Business plan?",
          a: "There is a partner tier for integrators running many customer sites under one account. The numbers are higher, and deliberately not infinite — a ceiling that can never be reached is a ceiling we cannot plan capacity against.",
        },
      ],
    },
    {
      type: "cta",
      title: "See the plans against your real usage",
      text: "The free plan runs one app with no card, so you can measure before you decide.",
      label: "Get started",
    },
  ],
};
