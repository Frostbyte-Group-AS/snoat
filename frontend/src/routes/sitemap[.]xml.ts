import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

import { ARTICLES, articlePath } from "@/content/articles";
import { SITE_URL } from "@/lib/seo";

/**
 * `sitemap.xml`.
 *
 * Adressen kommer fra `lib/seo.ts`, samme kilde som `canonical` og hreflang
 * bruker. Det er poenget: står sitemap-en på ett domene og canonical på et
 * annet, sier vi to ting til søkeroboten om hvor siden bor.
 *
 * Artiklene hentes fra registeret framfor å listes for hånd, så en ny fil under
 * `content/articles/` er med i sitemap-en fra første deploy.
 */

interface SitemapEntry {
  path: string;
  lastmod?: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: string;
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const entries: SitemapEntry[] = [
          { path: "/", changefreq: "weekly", priority: "1.0" },
          {
            path: "/articles",
            // Lista endrer seg når en artikkel kommer til; `lastmod` er derfor
            // den nyeste artikkelens dato, ikke dagens.
            lastmod: ARTICLES[0]?.updated ?? ARTICLES[0]?.published,
            changefreq: "weekly",
            priority: "0.8",
          },
          ...ARTICLES.map((article) => ({
            path: articlePath(article.slug),
            lastmod: article.updated ?? article.published,
            changefreq: "monthly" as const,
            priority: "0.7",
          })),
        ];

        const urls = entries.map((e) =>
          [
            `  <url>`,
            `    <loc>${SITE_URL}${e.path}</loc>`,
            e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : null,
            e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>` : null,
            e.priority ? `    <priority>${e.priority}</priority>` : null,
            `  </url>`,
          ]
            .filter(Boolean)
            .join("\n"),
        );

        const xml = [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
          ...urls,
          `</urlset>`,
        ].join("\n");

        return new Response(xml, {
          headers: {
            "Content-Type": "application/xml",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
