import type { Article } from "./types";

export const gratisHostingNettsideNorge: Article = {
  slug: "gratis-hosting-nettside-norge",
  lang: "no",
  title: "Gratis hosting av nettside i Norge: hva du får, og hvor grensa går",
  metaTitle: "Gratis hosting av nettside i Norge | Snoat",
  description:
    "Hva en gratisplan faktisk koster deg, hva Snoats gratisplan inneholder – og de fire spørsmålene du bør stille før du legger et prosjekt på en gratis tjeneste.",
  keywords: [
    "gratis hosting",
    "gratis hosting norge",
    "gratis webhotell",
    "hoste nettside gratis",
    "gratis hosting med eget domene",
    "statisk nettside hosting",
  ],
  category: "platform",
  published: "2026-08-05",
  related: ["deploye-next-js-i-norge", "alternativ-til-vercel-norge", "webhosting-norge-gdpr"],
  lead: "Gratis hosting er en helt reell ting, og den er ikke veldedighet. Noen betaler for strømmen, og det er verdt å vite hvem og hvordan før du legger et prosjekt der. Her er de fire vanlige forretningsmodellene bak en gratisplan, hva Snoats gratisplan faktisk gir, og når du bør flytte.",
  body: [
    { type: "h2", text: "Fire måter en gratisplan finansieres" },
    {
      type: "list",
      ordered: true,
      items: [
        "**Reklame i sidene dine.** Den eldste modellen. Du eier ikke lenger hele flata, og du kontrollerer ikke hvem som får satt en informasjonskapsel hos de besøkende.",
        "**Dataene dine.** Trafikk- og atferdsdata er produktet. For en nettside med innbyggere eller pasienter som besøkende er det en personvernvurdering du ikke rakk å gjøre.",
        "**Overskuddskapasitet.** Leverandøren har maskiner som ikke er fulle, og bruker restene til en gratisplan med reelle grenser. Ingen skjult motytelse, men grensene er ekte og de er der av en grunn.",
        "**Vekst.** Gratisplanen er en prøve, og prisen kommer når du blir stor nok. Helt legitimt – forutsatt at du vet hva neste steg koster før du bygger deg fast.",
      ],
    },
    {
      type: "p",
      text: "Snoats gratisplan er den tredje typen. Plattformen kjører på infrastruktur fra Frostbyte Group AS, og overskuddskapasiteten går til en gratisplan med tydelige tak framfor til ingenting. Det er hele modellen, og den er verdt å si rett ut: derfor er grensene konkrete, og derfor er de ikke til forhandling.",
    },
    { type: "h2", text: "Hva gratisplanen inneholder" },
    {
      type: "table",
      head: ["", "Gratis"],
      rows: [
        ["Kjørende dynamisk app", "1"],
        ["Statiske sider", "Ubegrenset"],
        ["Minne per kjørende app", "256 MB"],
        ["Minne under bygging", "1 GB"],
        ["vCPU per app", "0,5"],
        ["Byggeminutter per måned", "100"],
        ["Automatisk HTTPS", "Ja"],
        ["Eget domene", "Ja"],
        ["Deploy ved push fra GitHub", "Ja"],
        ["Dev-side per gren", "Nei"],
        ["Trafikkstatistikk", "Nei"],
      ],
    },
    {
      type: "p",
      text: "To ting i tabellen fortjener en forklaring, fordi de er de mest nyttige linjene i den.",
    },
    { type: "h3", text: "Statiske sider teller ikke" },
    {
      type: "p",
      text: "En statisk side – Astro, Vite, Hugo, ren HTML, eller et `next export` – kjører ingen container. Byggeresultatet hentes ut av image-et og legges på et volum som proxyen serverer direkte. Da finnes det ingen prosess å begrense minnet til, og derfor er antallet ubegrenset på alle planer, også gratis. Har du fem småsider og ett API, er det API-et som bruker plassen din.",
    },
    { type: "h3", text: "Eget domene og HTTPS er ikke forbeholdt betalende" },
    {
      type: "p",
      text: "Du kan peke ditt eget domene mot en gratis app, og sertifikatet utstedes automatisk ved første forespørsel. Vi har ikke gjort domene til en betalingsmur, fordi et domene er identiteten til prosjektet – ikke en ressurs som koster oss minne.",
    },
    { type: "h2", text: "Hvor 256 MB faktisk tar slutt" },
    {
      type: "p",
      text: "Tallet skal være til å regne på, så: 256 MB kjøreminne holder greit til en Node- eller Hono-API, en liten Express-tjeneste, en SvelteKit- eller Astro-side med server-rendering, eller en Next.js-app av moderat størrelse. Det holder dårlig til en app som holder store datasett i minnet, kjører bildebehandling med sharp på store originaler, eller starter flere arbeidsprosesser.",
    },
    {
      type: "p",
      text: "Merk at bygging får mer: 1 GB, fordi `next build` holder hele modulgrafen i minnet samtidig mens den ferdige serveren bare serverer ferdige filer. Å bygge og å kjøre koster ikke det samme, og derfor er det to tall og ikke ett. Er det bygget som ryker, er det som regel byggeminnet du trenger mer av – ikke kjøreminnet.",
    },
    { type: "h2", text: "Fire spørsmål før du legger noe på en gratisplan" },
    {
      type: "list",
      ordered: true,
      items: [
        "**Hva skjer når jeg vokser ut av den?** Sjekk prisen på neste steg nå, ikke den dagen du trenger den.",
        "**Kan jeg få dataene mine ut?** En eksport du ikke har prøvd, er en eksport du ikke har.",
        "**Hvor ligger dataene?** Gjelder også en hobbyside, i det øyeblikket den får et kontaktskjema.",
        "**Hva skjer hvis den sovner?** Mange gratisplaner parkerer inaktive apper og bruker flere sekunder på første forespørsel etterpå. Er siden en portefølje du sender til arbeidsgivere, er det den forespørselen som betyr noe.",
      ],
    },
    { type: "h2", text: "Når du bør flytte til en betalt plan" },
    {
      type: "p",
      text: "Tre ganske tydelige signaler: du trenger app nummer to som faktisk kjører samtidig, du vil ha et testmiljø på en egen gren, eller du vil se trafikken. Dev-sider og statistikk starter på Pro, som er 199 kr per måned eks. mva. med 10 apper, 2 GB minne per app, 500 byggeminutter og prioritert byggekø. Det fjerde signalet er tregere å kjenne igjen: at bygget begynner å ta tid fordi du står i en delt kø.",
    },
    {
      type: "faq",
      items: [
        {
          q: "Er gratisplanen tidsbegrenset?",
          a: "Nei, det er en plan og ikke en prøveperiode. Den har faste tak i stedet for en utløpsdato, og du trenger ikke oppgi kort for å bruke den.",
        },
        {
          q: "Kan jeg bruke gratisplanen kommersielt?",
          a: "Ja. Grensene er tekniske, ikke juridiske. Men én kjørende app uten statistikk er sjelden riktig oppsett for noe du tar betalt for å drifte.",
        },
        {
          q: "Får jeg deploy ved push på gratisplanen?",
          a: "Ja. GitHub-tilkoblingen, webhooken og hele byggepipelinen er den samme på alle planer. Det som skiller er kapasiteten og køprioriteten, ikke flyten.",
        },
        {
          q: "Sovner appen min hvis ingen besøker den?",
          a: "Nei. En kjørende app står og går. Det som kan stoppe den er at du selv slår den av, eller at kontoen ligger over gratisgrensene etter en nedgradering.",
        },
      ],
    },
    {
      type: "cta",
      title: "Legg opp den første siden gratis",
      text: "Én app, ubegrenset statiske sider, eget domene og HTTPS – uten kort.",
      label: "Kom i gang",
    },
  ],
};
