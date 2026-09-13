import type { Article } from "./types";

export const cloudActSchremsIiExplained: Article = {
  slug: "cloud-act-schrems-ii-explained",
  lang: "en",
  title: "The CLOUD Act, Schrems II and where your data actually lives",
  metaTitle: "CLOUD Act, Schrems II and EU Data Sovereignty | Snoat",
  description:
    "Why a European region does not by itself solve a jurisdiction problem — the CLOUD Act, Schrems II and the three levels of data sovereignty, explained for engineers.",
  keywords: [
    "cloud act eu",
    "schrems ii hosting",
    "data sovereignty europe",
    "digital sovereignty cloud",
    "eu us data privacy framework",
    "data residency vs data sovereignty",
  ],
  category: "compliance",
  published: "2026-09-02",
  related: [
    "gdpr-compliant-hosting-europe",
    "vercel-alternative-europe",
    "european-paas-comparison",
  ],
  lead: "“We selected the Frankfurt region” is an answer to a question about latency. It is not, on its own, an answer to a question about jurisdiction. The distinction has a name in the procurement documents — data residency versus data sovereignty — and it is the reason a growing number of European buyers now ask who owns the provider before they ask where the servers are.",
  body: [
    {
      type: "note",
      title: "Not legal advice",
      text: "Written by engineers who run a hosting platform, for engineers who have to answer a security questionnaire. Where it touches a decision, get it in front of your counsel or DPO.",
    },
    { type: "h2", text: "Three levels of sovereignty, and why they get conflated" },
    {
      type: "table",
      head: ["Level", "What it means", "What it does not cover"],
      rows: [
        [
          "Data residency",
          "The bytes are stored in a chosen country or region.",
          "Who can compel access to them, and who administers the machines.",
        ],
        [
          "Operational sovereignty",
          "Only staff in the chosen jurisdiction can technically access the systems.",
          "The legal orders the parent company can be served with.",
        ],
        [
          "Jurisdictional sovereignty",
          "The provider is incorporated and controlled inside the jurisdiction, so only its law applies.",
          "Nothing further — this is the level procurement rules increasingly ask for.",
        ],
      ],
    },
    {
      type: "p",
      text: "Most “EU cloud” offerings deliver the first level, some deliver the second, and the third requires a company that is not owned outside the jurisdiction. Knowing which level you have bought is most of the work.",
    },
    { type: "h2", text: "What the CLOUD Act actually says" },
    {
      type: "p",
      text: "The US Clarifying Lawful Overseas Use of Data Act, enacted in 2018, amended the Stored Communications Act to state explicitly that a US-based provider must produce data in its “possession, custody, or control” when served with valid legal process — regardless of which country the data is stored in. It was passed to resolve the Microsoft Ireland case, where exactly that question was in front of the Supreme Court.",
    },
    {
      type: "p",
      text: "Two consequences follow, and they are the whole argument in two sentences. First, storing data in an EU region does not remove a US provider's obligation, because the obligation attaches to the company rather than to the disk. Second, a provider can be prohibited from telling you that an order arrived, which means the absence of a transparency report entry is not evidence of anything.",
    },
    { type: "h2", text: "What Schrems II decided" },
    {
      type: "p",
      text: "In July 2020 the Court of Justice of the European Union invalidated the EU–US Privacy Shield (case C-311/18). The reasoning was not about paperwork but about US surveillance law — in particular the scope of FISA Section 702 and the lack of an effective remedy for EU individuals. Standard contractual clauses survived, but with a condition attached: the exporter must assess whether the law of the destination country undermines the clauses, and add supplementary measures if it does. That assessment is the transfer impact assessment that now sits in a lot of European compliance folders.",
    },
    {
      type: "p",
      text: "In July 2023 the Commission adopted an adequacy decision for the EU–US Data Privacy Framework, which gives certified US recipients a lawful transfer route again. It is the third such arrangement in a decade, and it is under legal challenge. If your architecture assumes it will still stand in five years, that assumption is a dependency worth writing down next to your other single points of failure.",
    },
    { type: "h2", text: "The engineering consequence" },
    {
      type: "p",
      text: "There is a clean way out of this class of problem: if the personal data never leaves the EEA and no non-EEA company controls the systems that hold it, Chapter V of the GDPR does not engage at all. There is no transfer to assess, no supplementary measure to design, and no adequacy decision to depend on. That is not a stronger legal argument — it is the absence of the argument.",
    },
    {
      type: "p",
      text: "Getting there is mostly about being honest with the inventory. In a typical modern web application, the data leaves the EEA through more doors than the hosting bill suggests:",
    },
    {
      type: "list",
      items: [
        "The managed database, which is often the first thing to be picked from a US-hosted marketplace.",
        "Error tracking, which ships stack traces containing user identifiers and sometimes request bodies.",
        "Product analytics and session replay, which are designed to capture behaviour in detail.",
        "Transactional email, which by definition processes addresses and message content.",
        "Font, script and icon CDNs, which see the visitor's IP address on every page view.",
        "CI, which clones the repository and often holds production secrets.",
        "The AI API you added last quarter, which now receives whatever your prompt includes.",
      ],
    },
    {
      type: "p",
      text: "Snoat is built to remove the first item and the last two on the hosting side: the app runs in a container on Norwegian infrastructure, the database is a self-hosted Supabase instance on the same infrastructure, builds run on our own build engine rather than a third-party CI, and traffic analytics are computed from our own proxy logs with the IP address discarded before storage. The remaining doors are yours to close, and knowing the list is how you close them.",
    },
    { type: "h2", text: "Questions worth putting in a security questionnaire" },
    {
      type: "list",
      ordered: true,
      items: [
        "In which country is the contracting entity incorporated, and who is the ultimate parent?",
        "Which of the three sovereignty levels above does the offering deliver, in your own words?",
        "Can any non-EEA entity in your group technically access production systems or backups?",
        "Do you rely on the EU–US Data Privacy Framework, standard contractual clauses, or neither?",
        "What is your process if you receive a foreign legal order for my data, and what will you tell me?",
      ],
    },
    {
      type: "faq",
      items: [
        {
          q: "Does the CLOUD Act mean US clouds are illegal in the EU?",
          a: "No. Using a US provider is lawful, and a great deal of European industry does it every day. What the CLOUD Act does is create a residual risk that a controller has to assess and document rather than assume away. Regulated sectors and public bodies often conclude that the risk is not acceptable for particular categories of data; a marketing site usually concludes otherwise.",
        },
        {
          q: "Does a European subsidiary of a US company solve it?",
          a: "Not by itself. The question is whether the parent has possession, custody or control of the data — which typically turns on who administers the systems and holds the keys. Sovereign-cloud arrangements attempt to sever exactly that link, and the details matter enormously.",
        },
        {
          q: "Is encryption enough?",
          a: "Encryption is necessary and it is not sufficient. It helps materially when the provider genuinely cannot access the keys. If the same provider manages the keys and the ciphertext, an order can reach both.",
        },
        {
          q: "Norway is not in the EU. Does that matter for GDPR?",
          a: "Norway is in the EEA, and the GDPR applies through the EEA agreement — implemented nationally in the Personal Data Act. Data stored in Norway is not a third-country transfer for EU controllers.",
        },
      ],
    },
    {
      type: "cta",
      title: "Remove the transfer question from your architecture",
      text: "Deploy on Norwegian infrastructure, with the database in the same place as the app.",
      label: "Get started",
    },
  ],
};
