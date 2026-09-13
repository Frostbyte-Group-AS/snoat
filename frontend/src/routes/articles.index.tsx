import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Reveal } from "@/components/Reveal";
import { SHELL, SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { ARTICLES, readingMinutes, type Article, type ArticleLang } from "@/content/articles";
import { articleListJsonLd } from "@/content/articles/jsonld";
import { ARTICLE_UI, CATEGORY_LABELS } from "@/content/articles/ui";
import { formattersFor } from "@/lib/format";
import { absoluteUrl } from "@/lib/seo";

/**
 * Listesiden for artiklene.
 *
 * Siden er tospråklig med vilje: den viser norske og engelske artikler side om
 * side, hver merket med språket sitt. Filteret er **klient-side og starter på
 * «alle»**, slik at den serverrendrede HTML-en inneholder lenken til hver
 * artikkel. Et filter som fjernet halve lista fra markupen ville skjult
 * halvparten av sidene for en søkerobot – interne lenker er hele grunnen til at
 * en slik oversikt finnes.
 */
export const Route = createFileRoute("/articles/")({
  head: () => ({
    meta: [
      { title: "Articles — hosting, GDPR and data sovereignty | Snoat" },
      {
        name: "description",
        content:
          "Guides and comparisons on European hosting, GDPR, data sovereignty and deploying modern web apps — in Norwegian and English.",
      },
      { property: "og:title", content: "Articles | Snoat" },
      {
        property: "og:description",
        content:
          "Guides and comparisons on European hosting, GDPR, data sovereignty and deploying modern web apps.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: absoluteUrl("/articles") },
    ],
    links: [{ rel: "canonical", href: absoluteUrl("/articles") }],
    scripts: [{ type: "application/ld+json", children: articleListJsonLd(ARTICLES) }],
  }),
  component: ArticlesIndex,
});

type Filter = "all" | ArticleLang;

function LangChip({ lang }: { lang: ArticleLang }) {
  // Samme uttrykk som språkvelgeren i headeren: to bokstaver, ikke et flagg.
  return (
    <span className="border-2 border-line px-[8px] py-[2px] font-body text-[12px] font-bold leading-none tracking-[0.08em] text-ink">
      {lang === "no" ? "NO" : "EN"}
    </span>
  );
}

function ArticleCard({ article, delay }: { article: Article; delay: number }) {
  // Datoen og lesetiden følger artikkelens språk, ikke grensesnittets: en norsk
  // artikkel skal ikke stå med «5 min read» over seg.
  const ui = ARTICLE_UI[article.lang];
  const format = formattersFor(article.lang);

  return (
    <Reveal as="article" delay={delay} className="h-full">
      <Link
        to="/articles/$slug"
        params={{ slug: article.slug }}
        className="ink-card-lg lift flex h-full flex-col gap-[14px] px-[26px] py-[28px]"
      >
        <div className="flex items-center gap-[12px]">
          <LangChip lang={article.lang} />
          <span className="font-body text-[13px] font-normal uppercase tracking-[0.08em] text-ink/70">
            {CATEGORY_LABELS[article.lang][article.category]}
          </span>
        </div>

        <span className="swoosh" aria-hidden="true" />

        <h2
          lang={article.lang === "no" ? "nb" : "en"}
          className="font-body text-[22px] font-normal leading-[1.25] text-ink lg:text-[27px]"
        >
          {article.title}
        </h2>

        <p
          lang={article.lang === "no" ? "nb" : "en"}
          className="font-body text-[16px] font-light leading-[1.55] text-ink lg:text-[18px]"
        >
          {article.description}
        </p>

        <p className="mt-auto pt-[10px] font-body text-[13px] font-light text-ink/70">
          {format.date(article.updated ?? article.published)} ·{" "}
          {ui.reading(readingMinutes(article))}
        </p>
      </Link>
    </Reveal>
  );
}

function ArticlesIndex() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");

  const shown = filter === "all" ? ARTICLES : ARTICLES.filter((a) => a.lang === filter);

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: t("articles.filter_all") },
    { id: "no", label: "Norsk" },
    { id: "en", label: "English" },
  ];

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-paper">
      <SiteHeader />

      <main className="flex-grow">
        <section className={`${SHELL} pt-[56px] lg:pt-[80px]`}>
          <h1 className="anim-rise font-display text-[clamp(2.25rem,4.167vw,3.75rem)] font-bold leading-[1.15] text-ink">
            {t("articles.title")}
          </h1>
          <span className="swoosh anim-draw mt-[10px]" aria-hidden="true" />
          <p className="anim-rise [--anim-delay:100ms] mt-[22px] max-w-[860px] font-body text-[clamp(1.0625rem,2vw,1.75rem)] font-light leading-[1.45] text-ink">
            {t("articles.lead")}
          </p>

          <div className="anim-rise [--anim-delay:180ms] mt-[34px] flex flex-wrap items-center gap-[12px]">
            {filters.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setFilter(option.id)}
                aria-pressed={filter === option.id}
                className={`${
                  filter === option.id ? "btn-ink" : "btn-outline"
                } h-[42px] px-[22px] font-body text-[15px] font-normal`}
              >
                {option.label}
              </button>
            ))}
            <span className="font-body text-[14px] font-light text-ink/60">
              {t("articles.count", { count: shown.length })}
            </span>
          </div>
        </section>

        <section className={`${SHELL} mt-[46px] pb-[20px]`}>
          <div className="grid grid-cols-1 gap-[26px] md:grid-cols-2 lg:grid-cols-3">
            {shown.map((article, i) => (
              <ArticleCard key={article.slug} article={article} delay={(i % 3) * 90} />
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
