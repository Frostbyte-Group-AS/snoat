import type { Article } from "./types";

export const gdprCompliantHostingEurope: Article = {
  slug: "gdpr-compliant-hosting-europe",
  lang: "en",
  title: "GDPR-compliant hosting: the checklist your provider should be able to answer",
  metaTitle: "GDPR Compliant Hosting: A Practical Checklist | Snoat",
  description:
    "GDPR compliance is not a badge a host can sell you. Here are the twelve questions to ask a hosting provider, and what a good answer looks like.",
  keywords: [
    "gdpr compliant hosting",
    "gdpr hosting provider",
    "is vercel gdpr compliant",
    "data processing agreement hosting",
    "eu data residency",
    "subprocessor list",
  ],
  category: "compliance",
  published: "2026-09-05",
  translationOf: "webhosting-norge-gdpr",
  related: [
    "cloud-act-schrems-ii-explained",
    "vercel-alternative-europe",
    "european-paas-comparison",
  ],
  lead: "No hosting provider can make you GDPR compliant, and any provider that says it can is selling you something. Compliance is a property of how you process personal data — the host is one processor in that chain. What a good provider can do is answer a specific set of questions clearly, in writing, without a sales call. Here is the list, and what a real answer sounds like.",
  body: [
    {
      type: "note",
      title: "Not legal advice",
      text: "This is an engineering checklist written by people who run a hosting platform, not a legal opinion. Where the answer changes what you write in a DPIA or a record of processing activities, involve your data protection officer or counsel.",
    },
    { type: "h2", text: "First, get the roles right" },
    {
      type: "p",
      text: "Under the GDPR you are almost always the controller for your users' data, and your hosting provider is a processor acting on your instructions (Article 28). That has two immediate consequences: you need a data processing agreement in place before the provider handles personal data, and you are responsible for the provider's suitability. “We use a big provider” is not a defence; “we assessed the provider against these criteria” is.",
    },
    { type: "h2", text: "The twelve questions" },
    {
      type: "list",
      ordered: true,
      items: [
        "Where is the data physically stored? A country, not a “region” marketing name.",
        "Who owns the company, and in which country is it incorporated? This decides which legal orders it can be served.",
        "Is there a data processing agreement available without negotiation, and does it name the subprocessors?",
        "What is the full subprocessor list, and how are changes announced?",
        "Does any personal data leave the EEA, including in backups, logs and support tooling?",
        "How long are access logs kept, and do they contain IP addresses? An IP address is personal data.",
        "What analytics runs by default, and does it inject anything into my pages?",
        "Where are backups stored, and can they be restored into the same jurisdiction?",
        "Is data encrypted in transit, and what happens to it at rest?",
        "How do I get a full export, and how do I get verified deletion?",
        "What is the incident notification process and timeline? You have 72 hours under Article 33; a processor that tells you on day four has broken your clock.",
        "Who on the provider's side can technically read my data, and what stops them?",
      ],
    },
    { type: "h2", text: "The two questions people forget" },
    {
      type: "h3",
      text: "Your logs are personal data",
    },
    {
      type: "p",
      text: "Web server access logs contain IP addresses, and an IP address is personal data under the GDPR — the CJEU settled that in Breyer. That makes log retention a processing decision, not an ops detail. Ask the number, and if the answer is “indefinitely”, that is a finding.",
    },
    {
      type: "p",
      text: "On Snoat, traffic analytics come from our own proxy's access log, which is streamed to the backend over an internal Docker network. The backend enriches the request, discards the IP address and writes only finished aggregates to the database. There is no third-party analytics vendor in the path, and no script is injected into your project — which also means your visitors have nothing to consent to for our measurement.",
    },
    { type: "h3", text: "The database is usually the real exposure" },
    {
      type: "p",
      text: "Teams move their frontend to a European host, feel better, and leave the database — the thing that actually contains names, emails and order history — in a US-hosted service. The app layer is the smaller half of the problem. Snoat runs a self-hosted Supabase instance on the same Norwegian infrastructure, so authentication and relational data sit in the same jurisdiction as the application that reads them.",
    },
    { type: "h2", text: "Third-country transfers, briefly" },
    {
      type: "p",
      text: "If personal data goes to a country outside the EEA, Chapter V of the GDPR applies. That means an adequacy decision, or standard contractual clauses plus a transfer impact assessment. The EU–US Data Privacy Framework provides an adequacy route for certified US recipients, but it is the third such arrangement in a decade — Safe Harbour and Privacy Shield were both struck down — and it is under legal challenge. Building an architecture that depends on the current adequacy decision surviving is a bet, and it is worth naming it as one.",
    },
    {
      type: "p",
      text: "The alternative is not exotic: if the data never leaves the EEA, Chapter V does not engage, and the transfer impact assessment is one line instead of a project.",
    },
    { type: "h2", text: "What we can and cannot claim about ourselves" },
    {
      type: "p",
      text: "Precision matters more than a badge here, so: your source code, your application data, your database and the traffic logs for your apps stay on Norwegian infrastructure operated by Frostbyte Group AS. Two external services are used for the platform's own operation, not for your users' traffic — an email provider for account and operational mail, and Stripe for payments if you subscribe to a paid plan. Both are named, and neither sits in the request path of your application.",
    },
    {
      type: "checks",
      items: [
        {
          on: true,
          text: "Application data, database and app traffic logs on Norwegian infrastructure",
        },
        {
          on: true,
          text: "Analytics derived from our own proxy logs, IP discarded before storage",
        },
        { on: true, text: "No tracking script injected into your project, ever" },
        {
          on: true,
          text: "Row-level security in the database, so a client can only read its own rows",
        },
        {
          on: false,
          text: "A promise that using us makes you compliant — that is not a thing a host can sell",
        },
      ],
    },
    {
      type: "faq",
      items: [
        {
          q: "Is Vercel GDPR compliant?",
          a: "Vercel publishes a data processing agreement and offers EU regions, and many European companies use it lawfully. The open question is not the paperwork but the jurisdiction: a US-headquartered provider may be subject to US legal process such as the CLOUD Act regardless of where a workload runs. Whether that residual risk is acceptable for your data is a decision for your controller-side assessment, and in regulated or public-sector procurement it is frequently decided by the rules rather than by preference.",
        },
        {
          q: "Do I need a DPIA to host a website?",
          a: "Not usually. A data protection impact assessment is required when processing is likely to result in a high risk to individuals — large-scale special-category data, systematic monitoring, profiling with legal effects. An ordinary marketing site with a contact form does not qualify. A patient portal does.",
        },
        {
          q: "Does using a European host mean I do not need a cookie banner?",
          a: "No. Cookie consent comes from the ePrivacy rules and is about storing information on the visitor's device, not about where your server sits. What a first-party, log-based analytics setup avoids is the need for consent for that measurement, because nothing is stored on the device and no third party receives the data.",
        },
        {
          q: "Where do backups live?",
          a: "On the same Norwegian infrastructure. A backup is a copy of personal data, and a backup in another jurisdiction is a transfer — asking the question is exactly right.",
        },
      ],
    },
    {
      type: "cta",
      title: "Run the checklist against us",
      text: "Start a free project and see the answers in the product rather than in a brochure.",
      label: "Get started",
    },
  ],
};
