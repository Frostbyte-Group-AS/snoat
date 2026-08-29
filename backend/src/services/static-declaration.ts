import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Finner rammeverk som ERKLÆRER at de bare produserer filer.
 *
 * ── HVORFOR DETTE IKKE BRYTER MED «VI GJETTER ALDRI» ────────────────────────
 * `services/static-site.ts` slår fast at Snoat aldri gjetter på om et prosjekt
 * er statisk, fordi et feilgjett gir en side som ser levende ut helt til noe
 * server-side kalles. Den regelen står, og denne filen bryter den ikke.
 *
 * Forskjellen er hva som leses. Å se en `dist/`-katalog og konkludere «statisk»
 * er et gjett: katalognavnet sier ingenting om hva appen trenger for å kjøre.
 * `output: "export"` i `next.config.js` er ikke et gjett — det er appforfatteren
 * som skriver, i sin egen konfigurasjon, at det ikke finnes en server. Å lese
 * det er å lese et manifest.
 *
 * Og vi bytter ikke modus på egen hånd uansett. Vi nekter bare å bygge noe som
 * beviselig ikke kan kjøre, og sier hvilken innstilling som må endres.
 *
 * ── HVORFOR BARE NEXT.JS ────────────────────────────────────────────────────
 * Fordi det er det ene tilfellet der utfallet er sikkert. `next start` avviser
 * en export-build eksplisitt:
 *
 *     Error: "next start" does not work with "output: export" configuration.
 *     Use "npx serve@latest out" instead.
 *
 * Prosessen avslutter med kode 1 etter under ett sekund. Det finnes ingen
 * konfigurasjon der kombinasjonen virker, så en hard feil her kan ikke ta feil.
 *
 * Astro og Nuxt er bevisst utenfor. Astro er statisk som STANDARD, altså i
 * fravær av en erklæring — og fravær er nettopp det vi ikke skal tolke. Skal de
 * inn, må det være på et positivt signal vi har verifisert, ikke på en antakelse
 * om hva en manglende adapter betyr.
 */

export interface StatiskErklaering {
  /** Rammeverket som erklærer seg statisk. Vises i loggen. */
  rammeverk: string;
  /** Filen erklæringen står i, relativt til reporoten. */
  fil: string;
  /** Selve linjen, trimmet, slik brukeren kan finne den igjen. */
  linje: string;
  /** Katalogen bygget legger filene i — det brukeren skal skrive inn. */
  foreslattKatalog: string;
}

/**
 * Next.js leter etter disse i rekkefølge. Vi leser alle vi finner, framfor å
 * stoppe på den første: et repo kan ha en gammel `next.config.js` liggende ved
 * siden av den `next.config.ts` som faktisk er i bruk, og da er det den som
 * erklærer export vi vil melde om.
 */
const NEXT_KONFIGURASJONER = [
  "next.config.ts",
  "next.config.mjs",
  "next.config.js",
  "next.config.cjs",
];

/** `output: "export"`, med enkle, doble eller backticks. */
const OUTPUT_EXPORT = /\boutput\s*:\s*(['"`])export\1/;

/**
 * Leter etter erklæringen, med kommentarer fjernet.
 *
 * Grunnen til at dette må gjøres i det hele tatt: eierfullstack sin egen
 * konfigurasjon har linjen
 *
 *     // Set output to 'export' for static build
 *
 * rett over erklæringen. Uten kommentarhåndtering ville en konfigurasjon der
 * linjen var kommentert UT — altså slått av — blitt lest som om den var på, og
 * vi ville nektet å bygge et prosjekt som er helt i orden.
 *
 * Blokk-kommentarer spores over flere linjer, ikke bare gjenkjent på `*` i
 * margen: `/*` etterfulgt av en uindentert linje er vanlig i generert kode.
 *
 * ── DEN ENE GRENSEN, OG HVILKEN VEI DEN FEILER ──────────────────────────────
 * En `/*` eller `//` inne i en STRENG blir behandlet som en kommentar. En
 * `baseUrl: "https://x"` på samme linje som erklæringen ville derfor kunne
 * skjule den. Vi vokter mot det vanligste tilfellet ved å ignorere `//` som står
 * rett etter et kolon — altså protokoll-skilletegnet.
 *
 * Det som står igjen feiler i riktig retning: vi MISTER en erklæring, og
 * deployen fortsetter som før. Vi finner aldri en som ikke er der, og kan derfor
 * ikke nekte å bygge et prosjekt som fungerer.
 */
function utenKommentarer(linje: string, iBlokk: boolean): { tekst: string; iBlokk: boolean } {
  let tekst = linje;

  if (iBlokk) {
    const slutt = tekst.indexOf("*/");
    if (slutt === -1) return { tekst: "", iBlokk: true };
    tekst = tekst.slice(slutt + 2);
    iBlokk = false;
  }

  // Fjern komplette blokker på linja, og oppdag en som åpnes uten å lukkes.
  for (;;) {
    const start = tekst.indexOf("/*");
    if (start === -1) break;
    const slutt = tekst.indexOf("*/", start + 2);
    if (slutt === -1) {
      tekst = tekst.slice(0, start);
      iBlokk = true;
      break;
    }
    tekst = tekst.slice(0, start) + tekst.slice(slutt + 2);
  }

  // `(^|[^:])//` — en `//` som ikke står rett etter kolon. Da overlever
  // `https://` mens en ekte linjekommentar blir kuttet.
  const linjekommentar = /(^|[^:])\/\//.exec(tekst);
  if (linjekommentar) {
    // Gruppe 1 er tom streng når treffet står helt i starten av linja. TypeScript
    // typer den likevel som mulig `undefined`, derfor `?? ""`.
    tekst = tekst.slice(0, linjekommentar.index + (linjekommentar[1] ?? "").length);
  }

  return { tekst, iBlokk };
}

function finnErklaering(innhold: string): string | null {
  let iBlokk = false;

  for (const raa of innhold.split("\n")) {
    const { tekst, iBlokk: neste } = utenKommentarer(raa, iBlokk);
    iBlokk = neste;
    // Returnerer den RÅ linjen, ikke den strippede: brukeren skal kunne søke
    // etter teksten i sin egen fil og finne den igjen.
    if (OUTPUT_EXPORT.test(tekst)) return raa.trim();
  }

  return null;
}

/**
 * Leser repoet og returnerer en erklæring om statisk utdata, eller null.
 *
 * Kaster aldri. En uleselig eller fraværende konfigurasjonsfil er det normale —
 * de fleste prosjekter har ingen — og skal ikke kunne velte en deployment.
 */
export async function finnStatiskErklaering(
  repoDirectory: string,
): Promise<StatiskErklaering | null> {
  for (const filnavn of NEXT_KONFIGURASJONER) {
    let innhold: string;
    try {
      innhold = await readFile(path.join(repoDirectory, filnavn), "utf8");
    } catch {
      continue;
    }

    const linje = finnErklaering(innhold);
    if (linje) {
      return {
        rammeverk: "Next.js",
        fil: filnavn,
        linje,
        foreslattKatalog: "out",
      };
    }
  }

  return null;
}
