import { absoluteUrl, PUBLISHER } from "@/lib/seo";

import { articlePath, plainText, readingMinutes } from "./index";
import type { Article } from "./types";
import { htmlLang } from "./ui";

/**
 * Strukturert data for en artikkel.
 *
 * Tre grafer i én `@graph`: `BlogPosting` (datoene og forfatteren Google viser
 * i resultatet), `BreadcrumbList` (stien Forside › Artikler › tittel) og
 * `FAQPage` når artikkelen faktisk har en FAQ-blokk. Vi lager aldri en
 * `FAQPage` av en artikkel uten spørsmål – strukturert data som ikke finnes i
 * teksten er brudd på Googles retningslinjer, ikke en snarvei.
 */
export function articleJsonLd(article: Article): string {
  const url = absoluteUrl(articlePath(article.slug));
  const faq = article.body.find((block) => block.type === "faq");

  const graph: Record<string, unknown>[] = [
    {
      "@type": "BlogPosting",
      "@id": `${url}#article`,
      headline: article.title,
      description: article.description,
      inLanguage: htmlLang(article.lang),
      datePublished: article.published,
      dateModified: article.updated ?? article.published,
      wordCount: plainText(article).split(/\s+/).filter(Boolean).length,
      timeRequired: `PT${readingMinutes(article)}M`,
      mainEntityOfPage: { "@type": "WebPage", "@id": url },
      author: { "@type": "Organization", name: PUBLISHER.name, url: PUBLISHER.url },
      publisher: {
        "@type": "Organization",
        name: PUBLISHER.name,
        legalName: PUBLISHER.legalName,
        url: PUBLISHER.url,
      },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Snoat", item: absoluteUrl("/") },
        { "@type": "ListItem", position: 2, name: "Articles", item: absoluteUrl("/articles") },
        { "@type": "ListItem", position: 3, name: article.title, item: url },
      ],
    },
  ];

  if (faq && faq.type === "faq") {
    graph.push({
      "@type": "FAQPage",
      "@id": `${url}#faq`,
      mainEntity: faq.items.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    });
  }

  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
}

/** Strukturert data for listesiden: en `Blog` med artiklene som elementer. */
export function articleListJsonLd(articles: Article[]): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    "@id": `${absoluteUrl("/articles")}#blog`,
    name: "Snoat",
    url: absoluteUrl("/articles"),
    publisher: {
      "@type": "Organization",
      name: PUBLISHER.name,
      legalName: PUBLISHER.legalName,
      url: PUBLISHER.url,
    },
    blogPost: articles.map((article) => ({
      "@type": "BlogPosting",
      headline: article.title,
      url: absoluteUrl(articlePath(article.slug)),
      datePublished: article.published,
      inLanguage: htmlLang(article.lang),
    })),
  });
}
