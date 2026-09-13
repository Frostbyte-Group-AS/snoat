import type { ArticleCategory, ArticleLang } from "./types";

/**
 * Tekstene rundt artikkelen – datolinja, «Les også», FAQ-overskriften.
 *
 * De ligger her og ikke i oversettelsesfilene under `locales/` med vilje. i18n bytter
 * språk etter mount, og en norsk artikkel med engelsk «Published» over seg er
 * feil både for leseren og for søkemotoren som ser den serverrendrede siden.
 * Ved å slå opp på artikkelens eget `lang` er hele siden i ett språk fra
 * første byte.
 *
 * Listesiden viser begge språk samtidig og bruker derimot i18n, siden den
 * følger grensesnittspråket og ikke ett dokuments språk.
 */
export const ARTICLE_UI = {
  no: {
    back: "← Alle artikler",
    published: "Publisert",
    updated: "Oppdatert",
    reading: (m: number) => `${m} min lesing`,
    contents: "Innhold",
    faq: "Ofte stilte spørsmål",
    related: "Les også",
    cta_default: "Kom i gang",
    author: "Snoat",
    lang_label: "Norsk",
  },
  en: {
    back: "← All articles",
    published: "Published",
    updated: "Updated",
    reading: (m: number) => `${m} min read`,
    contents: "Contents",
    faq: "Frequently asked questions",
    related: "Read next",
    cta_default: "Get started",
    author: "Snoat",
    lang_label: "English",
  },
} satisfies Record<ArticleLang, Record<string, unknown>>;

export const CATEGORY_LABELS: Record<ArticleLang, Record<ArticleCategory, string>> = {
  no: {
    comparison: "Sammenligning",
    compliance: "Personvern og regelverk",
    guide: "Veiledning",
    platform: "Plattform",
  },
  en: {
    comparison: "Comparison",
    compliance: "Privacy and compliance",
    guide: "Guide",
    platform: "Platform",
  },
};

/** `lang`-attributtet HTML faktisk skal ha. `no` er makrospråket, `nb` er bokmål. */
export function htmlLang(lang: ArticleLang): string {
  return lang === "no" ? "nb" : "en";
}

/**
 * Ankeret en H2 får, utledet av teksten sin.
 *
 * Utledet og ikke håndsatt: en id som skrives i innholdsfilen kommer i utakt
 * med overskriften i det noen redigerer den, og da peker innholdsfortegnelsen
 * på ingenting. Æ, ø og å skrives om framfor å bli strippet – «Hvorfor må
 * dataene ligge her» skal ikke bli `hvorfor-m-dataene-ligge-her`.
 */
export function headingId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[æ]/g, "ae")
      .replace(/[ø]/g, "oe")
      .replace(/[å]/g, "aa")
      .replace(/[`*[\]()]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      // Klippingen kommer FØR bindestrekene trimmes: gjør man det motsatt, kan
      // kuttet legge igjen en bindestrek på slutten av ankeret.
      .slice(0, 60)
      .replace(/^-+|-+$/g, "")
  );
}
