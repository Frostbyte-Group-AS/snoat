import { alternativTilVercelNorge } from "./alternativ-til-vercel-norge";
import { cloudActSchremsIiExplained } from "./cloud-act-schrems-ii-explained";
import { datasuverenitetNorskSky } from "./datasuverenitet-norsk-sky";
import { deployNextjsWithoutVercel } from "./deploy-nextjs-without-vercel";
import { deployeNextJsINorge } from "./deploye-next-js-i-norge";
import { europeanPaasComparison } from "./european-paas-comparison";
import { gdprCompliantHostingEurope } from "./gdpr-compliant-hosting-europe";
import { gratisHostingNettsideNorge } from "./gratis-hosting-nettside-norge";
import { hostingOffentligSektorKommune } from "./hosting-offentlig-sektor-kommune";
import type { Article, ArticleLang } from "./types";
import { vercelAlternativeEurope } from "./vercel-alternative-europe";
import { vercelPricingAlternative } from "./vercel-pricing-alternative";
import { webhostingNorgeGdpr } from "./webhosting-norge-gdpr";

/**
 * Registeret. Én ny artikkel = én ny fil + én linje her.
 *
 * Rekkefølgen i lista betyr ingenting; `ARTICLES` er sortert nyest først, og
 * det er den sorterte lista alt annet leser.
 */
const ALL: Article[] = [
  vercelAlternativeEurope,
  alternativTilVercelNorge,
  gdprCompliantHostingEurope,
  webhostingNorgeGdpr,
  cloudActSchremsIiExplained,
  datasuverenitetNorskSky,
  deployNextjsWithoutVercel,
  deployeNextJsINorge,
  vercelPricingAlternative,
  europeanPaasComparison,
  hostingOffentligSektorKommune,
  gratisHostingNettsideNorge,
];

export const ARTICLES: Article[] = [...ALL].sort((a, b) => b.published.localeCompare(a.published));

/** Banen artikkelen ligger på. Ett sted, slik at lenke og sitemap ikke skiller lag. */
export function articlePath(slug: string): string {
  return `/articles/${slug}`;
}

export function getArticle(slug: string): Article | undefined {
  return ARTICLES.find((article) => article.slug === slug);
}

export function articlesByLang(lang: ArticleLang): Article[] {
  return ARTICLES.filter((article) => article.lang === lang);
}

/** Artikkelen på det andre språket, når den finnes. Grunnlaget for hreflang. */
export function translationOf(article: Article): Article | undefined {
  if (article.translationOf) return getArticle(article.translationOf);
  return ARTICLES.find((other) => other.translationOf === article.slug);
}

/** All lesbar tekst i artikkelen, uten markup. Til ordtelling og utdrag. */
export function plainText(article: Article): string {
  const parts: string[] = [article.title, article.lead];

  for (const block of article.body) {
    switch (block.type) {
      case "h2":
      case "h3":
      case "p":
        parts.push(block.text);
        break;
      case "list":
        parts.push(...block.items);
        break;
      case "checks":
        parts.push(...block.items.map((item) => item.text));
        break;
      case "table":
        parts.push(...block.head, ...block.rows.flat());
        break;
      case "code":
        // Kommandoer er ikke prosa og skal ikke telle som lesetid.
        break;
      case "note":
        parts.push(block.title ?? "", block.text);
        break;
      case "faq":
        parts.push(...block.items.flatMap((item) => [item.q, item.a]));
        break;
      case "cta":
        parts.push(block.title, block.text ?? "");
        break;
    }
  }

  return parts.filter(Boolean).join(" ");
}

/**
 * Lesetid i minutter, 220 ord i minuttet, aldri under 2.
 *
 * Tallet regnes ut framfor å skrives i hver fil: et håndsatt «5 min» blir feil
 * i det noen redigerer avsnittet under det.
 */
export function readingMinutes(article: Article): number {
  const words = plainText(article).split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round(words / 220));
}

/**
 * «Les også». Eksplisitte `related` først, deretter samme språk og samme
 * kategori, og til slutt samme språk – aldri artikkelen selv, og aldri en
 * artikkel på et språk leseren ikke holder på å lese.
 */
export function relatedArticles(article: Article, limit = 3): Article[] {
  const picked: Article[] = [];
  const push = (candidate: Article | undefined) => {
    if (!candidate) return;
    if (candidate.slug === article.slug) return;
    if (picked.some((existing) => existing.slug === candidate.slug)) return;
    picked.push(candidate);
  };

  for (const slug of article.related ?? []) push(getArticle(slug));

  const sameLang = articlesByLang(article.lang);
  for (const candidate of sameLang) {
    if (picked.length >= limit) break;
    if (candidate.category === article.category) push(candidate);
  }
  for (const candidate of sameLang) {
    if (picked.length >= limit) break;
    push(candidate);
  }

  return picked.slice(0, limit);
}

export type { Article, ArticleCategory, ArticleLang, Block } from "./types";
