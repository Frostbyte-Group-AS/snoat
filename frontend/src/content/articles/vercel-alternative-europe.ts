import type { Article } from "./types";

export const vercelAlternativeEurope: Article = {
  slug: "vercel-alternative-europe",
  lang: "en",
  title: "The European Vercel alternative: same deploy flow, data that never leaves the EEA",
  metaTitle: "European Vercel Alternative — Deploy in Norway | Snoat",
  description:
    "Looking for a European alternative to Vercel? Here is what actually matters — ownership, region, CLOUD Act exposure, latency — and where the trade-offs are.",
  keywords: [
    "vercel alternative europe",
    "european vercel alternative",
    "eu alternative to vercel",
    "vercel eu hosting",
    "european hosting for next.js",
    "nordic hosting platform",
  ],
  category: "comparison",
  published: "2026-09-08",
  translationOf: "alternativ-til-vercel-norge",
  related: [
    "gdpr-compliant-hosting-europe",
    "cloud-act-schrems-ii-explained",
    "european-paas-comparison",
  ],
  lead: "Vercel set the standard for how deploying should feel: connect a repository, push, and the change is live. That part is not the problem. The problem is that for a growing number of European teams, the answer to “where does the data live, and who can be compelled to hand it over?” has become part of the procurement checklist — and “us-east-1” is not an answer that passes.",
  body: [
    {
      type: "p",
      text: "Snoat is a Norwegian hosting platform built on infrastructure operated by Frostbyte Group AS. It runs your app in an isolated container on Norwegian hardware, routes traffic through our own reverse proxy, issues TLS certificates automatically, and redeploys on every push to your chosen branch. The developer experience is deliberately familiar. The jurisdiction is not.",
    },
    { type: "h2", text: "What “European alternative” has to mean to be worth switching for" },
    {
      type: "p",
      text: "The phrase is used loosely. A US platform that offers a Frankfurt region is not the same thing as a European provider, and a European reseller of US infrastructure is not either. If you are evaluating alternatives, these are the four questions that separate marketing from substance:",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "Who owns the company? Ownership decides which legal orders the provider must answer to. A region setting does not change corporate domicile.",
        "Who owns the hardware, and where is it racked? “European cloud” built on a US hyperscaler inherits the hyperscaler's exposure.",
        "Where does the database live? Most teams solve the app layer and then keep their user data in a US-hosted database, which puts every row back where it started.",
        "Which third parties see the traffic? Analytics, error tracking, font CDNs and session replay tools each add a processor to your record of processing activities.",
      ],
    },
    {
      type: "p",
      text: "Snoat answers all four in one place: the company is Norwegian, the hardware is Norwegian, the database is a self-hosted Supabase instance on the same infrastructure, and traffic analytics are derived from our own proxy logs — no tracking script is ever injected into your project, and no third-party analytics vendor is involved.",
    },
    { type: "h2", text: "The part that must not change: the deploy flow" },
    {
      type: "p",
      text: "Data sovereignty is worth very little if it costs you the workflow. On Snoat you connect a GitHub repository through a GitHub App, pick a branch, and that is the whole setup. There is no Dockerfile to write: the build engine is Nixpacks, which inspects your source, detects the framework and produces an OCI image. Push to the branch and a webhook starts the next deployment.",
    },
    {
      type: "code",
      caption: "The entire deploy loop, from the outside",
      lines: [
        'git commit -m "fix: rounding in the invoice total"',
        "git push origin main",
        "# → build → health check → traffic switch. No downtime.",
      ],
    },
    {
      type: "p",
      text: "That last line is the ordering that matters. A new container starts next to the one currently serving traffic. It is health-checked. Only then does the proxy switch upstream atomically, and only after the switch is confirmed is the previous container retired. A deployment therefore costs no downtime, and a deployment that fails leaves the running version untouched — a broken build cannot take your site down.",
    },
    { type: "h2", text: "What actually changes when the region is Norway: distance" },
    {
      type: "p",
      text: "Latency arguments are usually made with invented numbers, so here is the floor instead. Light in fibre travels at roughly 200,000 km/s, which puts a hard lower bound on a round trip: about 1 ms per 100 km of cable, each way. Real routes are longer than the straight line and add switching delay, so treat the table below as the number nobody can beat, not the number you will measure.",
    },
    {
      type: "table",
      caption: "Theoretical minimum round-trip time from Oslo, straight-line distance in fibre",
      head: ["Destination", "Distance", "Fastest possible RTT"],
      rows: [
        ["Norway (same country)", "≈ 0–500 km", "≈ 0–5 ms"],
        ["Frankfurt", "≈ 1 180 km", "≈ 12 ms"],
        ["Dublin", "≈ 1 230 km", "≈ 12 ms"],
        ["Ashburn, Virginia", "≈ 6 300 km", "≈ 63 ms"],
        ["San Francisco", "≈ 8 600 km", "≈ 86 ms"],
      ],
    },
    {
      type: "note",
      title: "Round trips multiply",
      text: "One request is rarely one round trip. A cold HTTPS connection spends round trips on DNS, the TCP handshake and the TLS handshake before your server sees the first byte. Shaving 60 ms off a single round trip can therefore be worth several hundred milliseconds on the first paint for a Norwegian visitor — and first paint is the one your bounce rate reacts to.",
    },
    { type: "h2", text: "The trade-offs, stated plainly" },
    {
      type: "p",
      text: "A single-region European platform is not a global edge network, and pretending otherwise would waste your time. Here is the honest split:",
    },
    {
      type: "checks",
      items: [
        {
          on: true,
          text: "Zero-downtime rolling deploys with automatic rollback on a failed build",
        },
        { on: true, text: "Automatic HTTPS, including for your own domain and its subdomains" },
        { on: true, text: "Preview environments per branch, password-protected from birth" },
        {
          on: true,
          text: "First-party traffic analytics from proxy logs — no script in your page, no third-party processor",
        },
        {
          on: true,
          text: "Static sites served directly by the proxy, with no container and no per-site limit",
        },
        { on: false, text: "A global edge network with points of presence on every continent" },
        {
          on: false,
          text: "Hundreds of managed regions to choose from — the region is Norway, by design",
        },
        { on: false, text: "A large marketplace of one-click third-party integrations" },
      ],
    },
    {
      type: "p",
      text: "If your audience is Norwegian or Nordic, single-region in Norway is not a compromise — it is the closest region that exists. If your audience is genuinely worldwide and every millisecond in Sydney matters more than jurisdiction does, a global edge network is the right tool and we will say so.",
    },
    { type: "h2", text: "How a migration actually goes" },
    {
      type: "list",
      ordered: true,
      items: [
        "Create a project and connect the repository. Snoat detects the framework; there is nothing to configure for a standard Next.js, Vite, Astro, SvelteKit or Node service.",
        "Move your environment variables across. This is usually the longest step, and it is copy-paste.",
        "Deploy to the Snoat subdomain you get automatically and test the real thing on a real certificate.",
        "Point your domain: an A record for the apex and a CNAME for www. The certificate is issued on demand at the first request, so there is no waiting step to schedule.",
        "Lower the TTL a day before the switch, cut over, and keep the old deployment alive until traffic has drained.",
      ],
    },
    {
      type: "p",
      text: "The database is the step people underestimate. Moving hosting while leaving the database in a US region solves the smaller half of the problem. Snoat runs a self-hosted Supabase instance on the same Norwegian infrastructure, so auth and relational data land in the same jurisdiction as the app.",
    },
    {
      type: "faq",
      items: [
        {
          q: "Is Vercel not GDPR compliant?",
          a: "Vercel offers a data processing agreement and EU regions, and plenty of European companies use it lawfully. The concern that drives teams to European providers is not the DPA — it is that a US-headquartered company can be subject to US legal orders such as the CLOUD Act regardless of the region a workload runs in. Whether that risk is acceptable is a decision for your legal team, and for many public-sector buyers it is now decided by the procurement rules rather than by preference.",
        },
        {
          q: "Do I have to rewrite my app to move off Vercel?",
          a: "Not for a standard framework build. If your app relies on provider-specific primitives — edge middleware running in dozens of regions, image optimisation as a hosted service, or a proprietary function runtime — those parts need replacing. A conventional Next.js, Vite, Astro or Node application builds and runs unchanged.",
        },
        {
          q: "What happens when a deploy fails?",
          a: "Nothing visible to your users. The new container is built and health-checked beside the running one, and traffic only moves after the health check passes. A failed build leaves the previous version serving.",
        },
        {
          q: "Can I keep using GitHub?",
          a: "Yes. GitHub is the integration path: a GitHub App handles repository access, and a signed webhook triggers a deployment on every push to the branch the project is set to.",
        },
      ],
    },
    {
      type: "cta",
      title: "Deploy your first app on Norwegian infrastructure",
      text: "The free plan runs one app with no card. Connect a repository and see how the flow feels before you move anything that matters.",
      label: "Start deploying",
    },
  ],
};
