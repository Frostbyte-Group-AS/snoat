import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { ArticleBody } from "@/components/ArticleBody";
import { Reveal } from "@/components/Reveal";
import { SHELL, SiteFooter, SiteHeader } from "@/components/SiteChrome";
import {
  articlePath,
  getArticle,
  readingMinutes,
  relatedArticles,
  translationOf,
} from "@/content/articles";
import { articleJsonLd } from "@/content/articles/jsonld";
import { ARTICLE_UI, CATEGORY_LABELS, headingId, htmlLang } from "@/content/articles/ui";
import { formattersFor } from "@/lib/format";
import { absoluteUrl } from "@/lib/seo";

/**
 * Én artikkel.
 *
 * Alt som betyr noe for søk settes i `head()` og rendres derfor på serveren:
 * tittel, beskrivelse, canonical, Open Graph, hreflang mot oversettelsen, og
 * strukturert data (`BlogPosting`, `BreadcrumbList`, og `FAQPage` når
 * artikkelen faktisk har spørsmål).
 *
 * Teksten kommer fra `content/articles/` og ikke fra i18n. Serveren rendrer med
 * `lng: "en"` for å unngå hydration-mismatch, så en norsk artikkel skrevet som
 * oversettelsesnøkler ville blitt indeksert på engelsk. Her bærer dokumentet sitt
 * eget språk – både i `lang`-attributtet og i datolinja over teksten.
 */
export const Route = createFileRoute("/articles/$slug")({
  loader: ({ params }) => {
    // 404 på en ukjent slug framfor en tom side. Rot-ruten har allerede en
    // `notFoundComponent`, så det finnes ingenting å bygge her.
    if (!getArticle(params.slug)) throw notFound();
    return null;
  },
  head: ({ params }) => {
    const article = getArticle(params.slug);
    if (!article) return {};

    const url = absoluteUrl(articlePath(article.slug));
    const other = translationOf(article);

    const alternates = other
      ? [
          {
            rel: "alternate",
            hrefLang: htmlLang(article.lang),
            href: url,
          },
          {
            rel: "alternate",
            hrefLang: htmlLang(other.lang),
            href: absoluteUrl(articlePath(other.slug)),
          },
          {
            // x-default peker på den engelske utgaven: den er lesbar for flest,
            // og er det riktige svaret når leserens språk ikke matcher noen av
            // dem.
            rel: "alternate",
            hrefLang: "x-default",
            href: absoluteUrl(articlePath(article.lang === "en" ? article.slug : other.slug)),
          },
        ]
      : [];

    return {
      meta: [
        { title: article.metaTitle },
        { name: "description", content: article.description },
        { property: "og:title", content: article.title },
        { property: "og:description", content: article.description },
        { property: "og:type", content: "article" },
        { property: "og:url", content: url },
        { property: "article:published_time", content: article.published },
        ...(article.updated
          ? [{ property: "article:modified_time", content: article.updated }]
          : []),
      ],
      links: [{ rel: "canonical", href: url }, ...alternates],
      scripts: [{ type: "application/ld+json", children: articleJsonLd(article) }],
    };
  },
  component: ArticlePage,
});

/** Overskriftstekst uten inline-markup, til innholdsfortegnelsen. */
function stripInline(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "");
}

function ArticlePage() {
  const { slug } = Route.useParams();
  const article = getArticle(slug);
  if (!article) return null;

  const ui = ARTICLE_UI[article.lang];
  const lang = htmlLang(article.lang);
  const format = formattersFor(article.lang);
  const minutes = readingMinutes(article);
  const related = relatedArticles(article);

  const sections = [
    ...article.body
      .filter((block) => block.type === "h2")
      .map((block) => ({ id: headingId(block.text), text: stripInline(block.text) })),
    ...(article.body.some((block) => block.type === "faq")
      ? [{ id: headingId(ui.faq), text: ui.faq }]
      : []),
  ];

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-paper">
      <SiteHeader />

      <main className="flex-grow">
        {/* Lesebredden er smalere enn innholdsrailen: 1334 px brødtekst er ikke
            noe man leser, det er noe man skanner. */}
        <article lang={lang} className={`${SHELL} pt-[40px] lg:pt-[64px]`}>
          <div className="mx-auto max-w-[820px]">
            <Link
              to="/articles"
              className="font-body text-[15px] font-normal text-ink underline-offset-[6px] hover:underline"
            >
              {ui.back}
            </Link>

            <p className="mt-[26px] font-body text-[13px] font-normal uppercase tracking-[0.1em] text-ink/70">
              {CATEGORY_LABELS[article.lang][article.category]}
            </p>

            <h1 className="anim-rise mt-[10px] font-display text-[clamp(2rem,3.6vw,3.25rem)] font-bold leading-[1.15] text-ink">
              {article.title}
            </h1>
            <span className="swoosh anim-draw mt-[14px]" aria-hidden="true" />

            <p className="anim-rise [--anim-delay:90ms] mt-[24px] font-body text-[clamp(1.125rem,1.8vw,1.5rem)] font-light leading-[1.5] text-ink">
              {article.lead}
            </p>

            <p className="mt-[26px] font-body text-[14px] font-light text-ink/70">
              {article.updated
                ? `${ui.updated} ${format.date(article.updated)}`
                : `${ui.published} ${format.date(article.published)}`}{" "}
              · {ui.reading(minutes)}
            </p>

            <hr className="hairline mt-[26px]" />

            {sections.length > 2 && (
              <nav aria-label={ui.contents} className="ink-card mt-[32px] px-[24px] py-[22px]">
                <p className="font-body text-[13px] font-bold uppercase tracking-[0.1em] text-ink">
                  {ui.contents}
                </p>
                <ol className="mt-[14px] flex flex-col gap-[8px]">
                  {sections.map((section) => (
                    <li key={section.id}>
                      <a
                        href={`#${section.id}`}
                        className="font-body text-[16px] font-light text-ink underline-offset-[5px] hover:underline lg:text-[18px]"
                      >
                        {section.text}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            )}

            <div className="mt-[20px]">
              <ArticleBody blocks={article.body} lang={article.lang} />
            </div>
          </div>
        </article>

        {related.length > 0 && (
          <section className={`${SHELL} mt-[80px]`}>
            <div className="mx-auto max-w-[820px]">
              <h2 className="font-display text-[24px] font-bold leading-[1.2] text-ink lg:text-[30px]">
                {ui.related}
              </h2>
              <span className="swoosh mt-[10px]" aria-hidden="true" />

              <div className="mt-[26px] grid grid-cols-1 gap-[20px] md:grid-cols-3">
                {related.map((other, i) => (
                  <Reveal as="article" key={other.slug} delay={i * 90} className="h-full">
                    <Link
                      to="/articles/$slug"
                      params={{ slug: other.slug }}
                      lang={htmlLang(other.lang)}
                      className="ink-card lift flex h-full flex-col gap-[10px] px-[20px] py-[22px]"
                    >
                      <span className="font-body text-[12px] font-normal uppercase tracking-[0.08em] text-ink/70">
                        {CATEGORY_LABELS[other.lang][other.category]}
                      </span>
                      <h3 className="font-body text-[18px] font-normal leading-[1.3] text-ink lg:text-[20px]">
                        {other.title}
                      </h3>
                      <span className="mt-auto pt-[8px] font-body text-[13px] font-light text-ink/70">
                        {ARTICLE_UI[other.lang].reading(readingMinutes(other))}
                      </span>
                    </Link>
                  </Reveal>
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
