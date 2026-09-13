import type { Article } from "./types";

export const deployNextjsWithoutVercel: Article = {
  slug: "deploy-nextjs-without-vercel",
  lang: "en",
  title: "How to deploy Next.js without Vercel — and what actually breaks",
  metaTitle: "Deploy Next.js Without Vercel: What Breaks | Snoat",
  description:
    "A practical guide to running Next.js off Vercel: standalone output, ISR, image optimisation, middleware, and the parts that need replacing before you switch.",
  keywords: [
    "deploy next.js without vercel",
    "self host next.js",
    "next.js standalone output",
    "next.js isr self hosted",
    "next.js docker deploy",
    "next.js hosting europe",
  ],
  category: "guide",
  published: "2026-08-28",
  related: ["vercel-alternative-europe", "vercel-pricing-alternative", "european-paas-comparison"],
  lead: "Next.js is an open-source framework that runs anywhere Node runs, and `next start` is a supported production command — not a fallback. But Vercel also provides a set of platform features that Next.js quietly assumes when it is deployed there. Knowing which four they are is the difference between a two-hour migration and a surprising week.",
  body: [
    { type: "h2", text: "The baseline: a Next.js app is a Node server" },
    {
      type: "p",
      text: "For anything other than a fully static export, a Next.js production deployment is a long-running Node process listening on a port. Build it, start it, put a reverse proxy with TLS in front of it, and you have the same thing every managed platform is running underneath.",
    },
    {
      type: "code",
      caption: "The whole thing, without a platform",
      lines: [
        "npm ci",
        "npm run build",
        "PORT=3000 npm run start",
        "# a reverse proxy terminates TLS and forwards to :3000",
      ],
    },
    {
      type: "p",
      text: 'If you are building a container image yourself, set `output: "standalone"` in `next.config.js`. Next then emits a minimal server bundle with only the dependencies it actually traced, which turns a multi-hundred-megabyte image into a small one. On Snoat you do not write a Dockerfile at all — the build engine is Nixpacks, which inspects the repository, detects Next.js and produces an OCI image — but the flag still pays for itself in build and boot time.',
    },
    {
      type: "note",
      title: "Pin the runtime in the repository",
      text: "Set `engines.node` in package.json or commit an .nvmrc. Snoat reads both and only applies its own default when the repository says nothing — so the version that built on your machine is the version that builds in production, and an upstream default change cannot move it under you.",
    },
    { type: "h2", text: "The four things Vercel does that you have to replace" },
    { type: "h3", text: "1. Incremental static regeneration needs somewhere to write" },
    {
      type: "p",
      text: "ISR and the data cache write to the filesystem under `.next/cache` by default. In a container that is fine while the container lives, and it is gone the moment you deploy again — which means the first request after each deployment pays the full regeneration cost. With more than one replica it is worse: each replica keeps its own cache, so a visitor can see a fresh page and then an older one depending on which instance answers.",
    },
    {
      type: "p",
      text: "The fixes, in increasing order of effort: accept the cold cache after a deploy (fine for most sites), mount a persistent volume for the cache directory, or implement a custom cache handler backed by Redis or Postgres so all replicas share one cache. Next.js supports the third option explicitly through `cacheHandler` in the config.",
    },
    { type: "h3", text: "2. Image optimisation runs in your process now" },
    {
      type: "p",
      text: "`next/image` optimisation is done by a hosted service on Vercel. Self-hosted, Next does it in-process with sharp, which is the right thing but shifts CPU and memory onto your container — resizing a large source image is not free. Three sane paths: keep it and size the container accordingly, pre-optimise images at build time, or point `images.loader` at an external image service. Whatever you choose, set `images.formats` and `deviceSizes` deliberately rather than letting every variant be generated on demand.",
    },
    { type: "h3", text: "3. Middleware is Node, not edge" },
    {
      type: "p",
      text: "Middleware still runs, but it runs in your server process rather than at dozens of points of presence. For auth checks and rewrites that is not a functional difference. For code that assumed a geographically distributed runtime — geolocation headers, per-region A/B splits, latency-sensitive redirects at the edge — the assumption is gone and the logic needs revisiting.",
    },
    { type: "h3", text: "4. Everything after the build is now your platform's job" },
    {
      type: "p",
      text: "Certificates, HTTP to HTTPS, routing a domain, restarting a crashed process, keeping the old version alive while the new one boots, and knowing when the app is down. This is exactly the part a hosting platform is for, and it is worth listing so you can check that whatever you move to actually does it. On Snoat: our proxy terminates TLS and issues certificates on demand, a new container is started and health-checked beside the running one before traffic switches, containers restart on failure a bounded number of times rather than looping forever, and a background sweep compares what the database claims is running against what the container runtime actually has — so an app whose container died shows as down instead of continuing to claim it is live.",
    },
    { type: "h2", text: "Checklist before you flip DNS" },
    {
      type: "list",
      ordered: true,
      items: [
        "Build and run the production command locally, not just `next dev`. Half of all migration surprises show up here.",
        "Move every environment variable, and check which ones are needed at build time versus at runtime. A `NEXT_PUBLIC_` value is baked into the bundle at build time.",
        "Decide the ISR story: cold cache after deploy, persistent volume, or shared cache handler.",
        "Decide the image story, and confirm the container has enough memory for sharp.",
        "Deploy to the platform subdomain and test the real thing on a real certificate before touching DNS.",
        "Lower your DNS TTL a day ahead, then point the apex A record and the www CNAME.",
        "Keep the old deployment running until traffic has drained, then turn it off.",
      ],
    },
    { type: "h2", text: "What you get in exchange" },
    {
      type: "p",
      text: "Portability, mostly. An app that builds from source with a standard command and runs as a Node process can move between providers in an afternoon. That is worth something on its own, and it is worth a lot when the reason for moving is a jurisdiction requirement rather than a price.",
    },
    {
      type: "faq",
      items: [
        {
          q: "Is self-hosting Next.js officially supported?",
          a: 'Yes. `next start` and `output: "standalone"` are documented production paths, and the Next.js documentation has a self-hosting section covering caching, images and middleware. It is not a hack.',
        },
        {
          q: "Do I need a Dockerfile?",
          a: "Not on Snoat. Nixpacks inspects the repository, detects the framework and builds the image. If you already have a Dockerfile that you like, a build that produces a Node server behaves the same way from the platform's point of view.",
        },
        {
          q: "What about the App Router, server actions and streaming?",
          a: "All of them are framework features and work off Vercel. They need a Node server rather than a static export, which is the same requirement as any other dynamic Next.js deployment.",
        },
        {
          q: "Can I still deploy on every push?",
          a: "Yes. Snoat connects through a GitHub App and a signed webhook starts a deployment on every push to the branch the project is set to. Other branches can run as separate preview sites with their own hostname.",
        },
      ],
    },
    {
      type: "cta",
      title: "Point Snoat at your Next.js repository",
      text: "No Dockerfile, no pipeline to write. Connect the repo, pick a branch, and watch the build log stream.",
      label: "Get started",
    },
  ],
};
