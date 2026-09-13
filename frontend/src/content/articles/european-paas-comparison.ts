import type { Article } from "./types";

export const europeanPaasComparison: Article = {
  slug: "european-paas-comparison",
  lang: "en",
  title: "European hosting for modern web apps: four approaches, honestly compared",
  metaTitle: "European PaaS Options Compared (2026) | Snoat",
  description:
    "US platform with an EU region, European IaaS, self-hosted PaaS, or a European managed platform? What each approach costs you in ops, jurisdiction and reach.",
  keywords: [
    "european paas",
    "european cloud providers",
    "self hosted paas coolify",
    "hetzner vs vercel",
    "scaleway ovh hosting",
    "eu hosting for developers",
  ],
  category: "comparison",
  published: "2026-08-14",
  related: [
    "vercel-alternative-europe",
    "cloud-act-schrems-ii-explained",
    "vercel-pricing-alternative",
  ],
  lead: "There are four realistic ways to host a modern web application in Europe, and the interesting differences are not features — they are who carries the operational burden and which legal jurisdiction ends up on your record of processing activities. Here is the map, including the cases where the answer is not us.",
  body: [
    { type: "h2", text: "1. A US platform with a European region" },
    {
      type: "p",
      text: "The path of least resistance: keep the developer experience you know and pick an EU region in a dropdown. Deployment previews, a mature CLI, an integration marketplace, a global edge network, and documentation for every framework.",
    },
    {
      type: "p",
      text: "What it does not solve is jurisdiction. Region is data residency; it does not change which company controls the systems or which legal orders that company can be served with. For a marketing site that is usually an acceptable residual risk. For a case-handling system in a public body it is frequently the thing that disqualifies the option before anyone looks at features.",
    },
    { type: "h2", text: "2. European IaaS, managed by you" },
    {
      type: "p",
      text: "Rent servers from a European provider — Hetzner in Germany and Finland, Scaleway or OVHcloud in France, a national provider in your own country — and run your own stack on top. Jurisdiction is clean, capacity per krone is excellent, and you control every layer.",
    },
    {
      type: "p",
      text: "The cost is that every layer is now yours: OS patching, container runtime, reverse proxy and certificates, zero-downtime deploys, health checks, log retention, backups and restore drills, monitoring, and the on-call rotation that gives those meaning. That work is entirely doable — plenty of teams do it well — but it is a permanent part-time job, and it is the part that gets deferred when a release is due.",
    },
    { type: "h2", text: "3. A self-hosted PaaS on European IaaS" },
    {
      type: "p",
      text: "The middle path that has become popular: install an open-source platform layer such as Coolify, Dokku or CapRover on a European VPS and get a deploy-from-git workflow on infrastructure you rent directly. You keep the jurisdiction of option 2 and recover much of the developer experience of option 1.",
    },
    {
      type: "p",
      text: "You still own the layer below, and now you own the platform layer too: upgrading it, recovering it when an upgrade goes sideways, and understanding it well enough to debug a deploy at 23:00. It is a genuinely good answer for a team with an ops-minded engineer and a strong reason to control the platform. It is a poor answer for a team of three who wanted to ship a product.",
    },
    { type: "h2", text: "4. A European managed platform" },
    {
      type: "p",
      text: "Somebody else runs the platform layer, and that somebody is incorporated in the jurisdiction you need. This is where Snoat sits: a Norwegian company, Norwegian hardware, deploy from GitHub, build without a Dockerfile, automatic TLS including for your own domain and its subdomains, zero-downtime rolling deploys, preview sites per branch, and a self-hosted database on the same infrastructure.",
    },
    {
      type: "p",
      text: "The trade-off is reach and breadth. One region in Norway is the right region for a Nordic audience and the wrong one for a genuinely global product. A young platform has a shorter integration list than a large one. Both of those are real, and neither is fixed by wording them carefully.",
    },
    { type: "h2", text: "The comparison as a table" },
    {
      type: "table",
      head: ["", "US platform, EU region", "European IaaS", "Self-hosted PaaS", "European managed"],
      rows: [
        ["Jurisdictional sovereignty", "No", "Yes", "Yes", "Yes"],
        ["Ops burden on you", "None", "High", "Medium", "None"],
        ["Deploy-from-git out of the box", "Yes", "You build it", "Yes", "Yes"],
        ["Database in the same jurisdiction", "Extra work", "You run it", "You run it", "Included"],
        ["Global edge reach", "Yes", "No", "No", "No"],
        ["Cost shape", "Usage-based", "Fixed servers", "Fixed servers", "Fixed plan"],
        ["Who is on call", "The vendor", "You", "You", "The vendor"],
      ],
    },
    { type: "h2", text: "How to choose without a spreadsheet" },
    {
      type: "list",
      items: [
        "**Is jurisdiction a requirement or a preference?** If a procurement rule or a DPIA decides it, options 2–4 are your shortlist and features come second.",
        "**Do you have an engineer who wants to own infrastructure?** If yes, options 2 and 3 are cheaper and better than they look. If no, they are more expensive than they look.",
        "**Where do your users actually connect from?** Check your own analytics before buying global reach. Most Nordic products are ninety-something percent Nordic.",
        "**What does the bill need to look like?** A fixed line in an approved budget and a usage-based invoice are different products, whatever the annual total says.",
      ],
    },
    {
      type: "note",
      title: "Where we would tell you to go elsewhere",
      text: "If you need points of presence on four continents, a large marketplace of managed add-ons, or a hosted service for a runtime we do not build for, a bigger platform is the honest answer. We would rather say that here than have you discover it during a migration.",
    },
    {
      type: "faq",
      items: [
        {
          q: "Is self-hosting Coolify on Hetzner not just cheaper?",
          a: "In server cost, usually yes. The comparison is only fair if you also price the hours: platform upgrades, certificate and proxy issues, backup restores you have actually tested, and being the person who is paged. If those hours are free because someone on the team enjoys them, self-hosting is a strong option and we will not pretend otherwise.",
        },
        {
          q: "Can I move away later?",
          a: "Yes, and you should check that before you commit anywhere. Snoat builds standard repositories with Nixpacks and runs them as ordinary containers, so an app that runs here runs on any container host. There is no proprietary runtime to unpick.",
        },
        {
          q: "What about Kubernetes?",
          a: "It is a fifth option and a good one at a certain scale. Below that scale it is a platform team's worth of complexity for a workload that is three containers and a database. If you are asking whether you need it, you probably do not yet.",
        },
      ],
    },
    {
      type: "cta",
      title: "Try the managed path on a free plan",
      text: "One app, no card, and the same build pipeline as the paid plans.",
      label: "Get started",
    },
  ],
};
