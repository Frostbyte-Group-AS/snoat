/**
 * Adressen sidene omtaler seg selv med.
 *
 * `canonical`, `og:url`, hreflang og `sitemap.xml` må alle peke på samme
 * absolutte URL, ellers konkurrerer siden med seg selv i indeksen. Verdien
 * kommer fra `VITE_SITE_URL` når den er satt (staging skal ikke kalle seg
 * snoat.com), med produksjonsdomenet som standard.
 */
const configured = (import.meta.env.VITE_SITE_URL as string | undefined)?.trim();

export const SITE_URL = (configured && configured.length > 0 ? configured : "https://snoat.com")
  // Etterfølgende skråstrek gir `https://snoat.com//articles`, som er en egen URL.
  .replace(/\/+$/, "");

/** Absolutt URL av en rutebane. `path` skal begynne med `/`. */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Organisasjonen bak plattformen. Gjentas i strukturert data på artiklene. */
export const PUBLISHER = {
  name: "Snoat",
  legalName: "Frostbyte Group AS",
  url: SITE_URL,
} as const;
