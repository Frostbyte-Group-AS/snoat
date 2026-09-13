/**
 * Innholdsmodellen for artiklene under `/articles`.
 *
 * Artiklene er **data, ikke i18n-nøkler**, og det er et bevisst valg.
 * `lib/i18n.ts` rendrer serversiden med `lng: "en"` for å unngå
 * hydration-mismatch, så en artikkel skrevet som oversettelsesnøkler ville
 * blitt indeksert på engelsk uansett hvilket språk den var ment å ha. Hver
 * artikkel bærer derfor sitt eget `lang`, sin egen URL og sin egen tekst, og
 * rendres identisk på server og klient.
 *
 * Teksten er strukturerte blokker framfor markdown eller HTML: da finnes det
 * ingen parser å stole på, ingen `dangerouslySetInnerHTML`, og hver blokk kan
 * få riktige klasser fra designsystemet i `05_design_system.md`.
 */

/** Språket artikkelen er skrevet på. Styrer `lang`-attributt og hreflang. */
export type ArticleLang = "no" | "en";

/** Emneinndelingen listesiden filtrerer og merker på. */
export type ArticleCategory = "comparison" | "compliance" | "guide" | "platform";

export type Block =
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "p"; text: string }
  /** Punktliste. `ordered` gir nummerering i stedet for kvadratbullet. */
  | { type: "list"; ordered?: boolean; items: string[] }
  /** Liste med ✓/✕ – `Mark`-merket fra prisekortene. Til ja/nei-oppstillinger. */
  | { type: "checks"; items: { on: boolean; text: string }[] }
  | { type: "table"; caption?: string; head: string[]; rows: string[][] }
  /** Kommando eller konfigurasjon. Rendres i terminalflata, ikke som prosa. */
  | { type: "code"; caption?: string; lines: string[] }
  /** Innrammet sidebemerkning. Ett kort, ikke en farget flate. */
  | { type: "note"; title?: string; text: string }
  /**
   * Spørsmål og svar. Alltid utfelt i DOM-en – en artikkel som skjuler svarene
   * bak et trekkspill uten JavaScript gir Google en tom seksjon. Blokka mater
   * også `FAQPage`-strukturert data på artikkelsiden.
   */
  | { type: "faq"; items: { q: string; a: string }[] }
  | { type: "cta"; title: string; text?: string; label: string };

export interface Article {
  /** URL-en: `/articles/<slug>`. Endres aldri etter publisering. */
  slug: string;
  lang: ArticleLang;
  /** H1-en på siden. Kan være lengre enn `metaTitle`. */
  title: string;
  /** `<title>`-taggen. Hold den under ~60 tegn, ellers klipper Google den. */
  metaTitle: string;
  /** `meta description`, 150–160 tegn. Skrives, ikke genereres fra ingressen. */
  description: string;
  /**
   * Søkeordene artikkelen er skrevet for. Dette er **dokumentasjon for oss** –
   * `meta keywords` er ignorert av alle søkemotorer og settes ikke.
   */
  keywords: string[];
  category: ArticleCategory;
  /** ISO-dato, `YYYY-MM-DD`. */
  published: string;
  /** ISO-dato. Settes ved reell revisjon, ikke ved retting av en skrivefeil. */
  updated?: string;
  /** Ingressen: står under H1-en i større, lys skrift, og er ikke en blokk. */
  lead: string;
  body: Block[];
  /** Samme artikkel på det andre språket. Kilden til hreflang-paret. */
  translationOf?: string;
  /** Slugger som lenkes fra «Les også». Tomt felt gir automatisk utvalg. */
  related?: string[];
}
