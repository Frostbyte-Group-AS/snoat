import type { Article } from "./types";

export const deployeNextJsINorge: Article = {
  slug: "deploye-next-js-i-norge",
  lang: "no",
  title: "Slik deployer du Next.js på norsk infrastruktur, steg for steg",
  metaTitle: "Deploye Next.js i Norge – steg for steg | Snoat",
  description:
    "Fra tomt repo til live app på norsk infrastruktur: rammeverksgjenkjenning, miljøvariabler, eget domene, dev-side per gren og hva loggen forteller når det feiler.",
  keywords: [
    "deploye next.js",
    "hoste next.js i norge",
    "next.js hosting norsk",
    "deploye fra github",
    "hoste vite astro sveltekit",
    "utrulling uten nedetid",
  ],
  category: "guide",
  published: "2026-08-28",
  related: [
    "alternativ-til-vercel-norge",
    "gratis-hosting-nettside-norge",
    "webhosting-norge-gdpr",
  ],
  lead: "Denne veiledningen går gjennom hele veien fra et repo på GitHub til en app som svarer på et eget domene med gyldig HTTPS – og hva som skjer i hvert steg, slik at du vet hvor du skal se når noe ikke stemmer. Det tar omtrent så lang tid å lese som det tar å gjøre.",
  body: [
    { type: "h2", text: "1. Koble til repoet" },
    {
      type: "p",
      text: "Innlogging går via GitHub, og tilgangen til koden går gjennom en GitHub App du installerer på kontoen eller organisasjonen din. Du velger hvilke repoer appen får se – Snoat får aldri en generell lesetilgang til alt du eier. Deretter oppretter du prosjektet, velger repo og eventuelt gren. Står grenfeltet tomt, brukes repoets standardgren, og det er svaret for de fleste.",
    },
    { type: "h2", text: "2. Byggingen: ingen Dockerfile" },
    {
      type: "p",
      text: "Byggemotoren er Nixpacks. Den leser kildekoden, kjenner igjen rammeverket – Next.js, Vite, Astro, SvelteKit, Node, Python – og produserer et OCI-image uten at du skriver en linje Docker. Kjøretidsversjonen leses fra repoet: `engines.node` i package.json eller en `.nvmrc`. Sier repoet ingenting, settes Snoat-standarden, og først da.",
    },
    {
      type: "code",
      caption: "Det Snoat gjør på din side av `git push`",
      lines: [
        "git clone --depth 1 --branch <gren>",
        "nixpacks build   → OCI-image",
        "docker run       → ny container ved siden av den gamle",
        "helsesjekk       → svarer den nye containeren?",
        "PATCH caddy      → trafikken byttes atomisk",
        "stopp gammel     → først nå",
      ],
    },
    {
      type: "p",
      text: "Rekkefølgen er hele poenget. Den gamle containeren serverer trafikk helt til den nye er bekreftet oppe. En utrulling koster derfor ingen nedetid, og en utrulling som feiler lar den kjørende versjonen stå urørt.",
    },
    { type: "h2", text: "3. Miljøvariabler" },
    {
      type: "p",
      text: "Legg dem inn i prosjektinnstillingene før første deployment. Skill mellom det som trengs under byggingen og det som trengs ved kjøring: en `NEXT_PUBLIC_`-variabel bakes inn i bundelen når bygget kjører, så den må være satt før du deployer – ikke etterpå. Verdiene vises maskert i grensesnittet og redigeres fra samme sted.",
    },
    {
      type: "note",
      title: "Hemmeligheter i byggeloggen",
      text: "Byggeloggen strømmes til dashbordet og lagres på deploymenten. Alt som ser ut som en credential fjernes før det skrives – men en `console.log` av en API-nøkkel i din egen byggeskript er fortsatt din egen `console.log`. Sjekk den før du deler en logg med noen.",
    },
    { type: "h2", text: "4. Statisk eller dynamisk – to helt ulike kjøremodus" },
    {
      type: "p",
      text: "Er prosjektet en statisk build – `astro build`, `vite build`, `next export`, en Hugo-side – trenger det ingen container. Byggeresultatet hentes ut av image-et og legges på et delt volum som proxyen serverer direkte. Det er raskere, det bruker ikke minne, og statiske sider teller ikke mot appgrensen på noen plan. Trenger appen en Node-prosess, kjører den som en container med minne og CPU fra planen din.",
    },
    { type: "h2", text: "5. Dev-side per gren" },
    {
      type: "p",
      text: "En dev-side er samme repo på en annen gren, med egen container og eget vertsnavn på formen `<gren>.<prosjekt>.snoat.com`. Den er passordbeskyttet fra første deployment, så en gren under arbeid ligger ikke åpen på internett mens du tester. Du kan slå den av og på uten å slette den – en avslått dev-side bruker ikke minne og teller ikke mot grensen din.",
    },
    { type: "h2", text: "6. Eget domene" },
    {
      type: "p",
      text: "Prosjektet får `<prosjekt>.snoat.com` automatisk. Skal du bruke ditt eget, viser DNS-fanen nøyaktig hvilke records du skal sette: A-record på apex mot serverens IP, og CNAME for `www`. Sertifikatet utstedes ved første forespørsel til domenet, så det finnes ingen ventetid å planlegge rundt. Fanen måler de tre leddene hver for seg – DNS, rute og sertifikat – slik at du ser hvilket av dem som ikke er på plass i stedet for å gjette.",
    },
    {
      type: "p",
      text: "Et eget domene dekker også subdomenene sine (`*.dittdomene.no`). En flerleietaker-app kan derfor gi hver av sine kunder et eget vertsnavn uten at du registrerer dem én for én.",
    },
    { type: "h2", text: "7. Når det feiler – hvor du ser" },
    {
      type: "list",
      items: [
        "**Byggeloggen** strømmes mens bygget kjører, og kjente feilsignaturer oversettes til en forklaring med råd framfor en rå stacktrace.",
        "**Statusmerket** skiller mellom I kø, Bygger, Live, Feilet og Nede. «Nede» betyr at containeren ikke lenger finnes – et periodisk sveip sammenligner det databasen påstår kjører mot det som faktisk kjører, og retter tilstanden.",
        "**Feil-fanen** viser feilene appen selv rapporterer i kjøring, ikke bare de som stoppet bygget.",
        "**Statistikk-fanen** kommer fra proxy-loggen, så den har responstid, feilrate og båndbredde – ikke bare sidevisninger.",
        "**E-post** når den første deploymenten går live, og når en container faller ut eller kommer tilbake.",
      ],
    },
    {
      type: "p",
      text: "En krasjende app restartes et begrenset antall ganger og blir så stående – i stedet for å restarte i det uendelige i stillhet. En krasj-loop skal være synlig, ikke skjult av en restartpolicy.",
    },
    {
      type: "faq",
      items: [
        {
          q: "Må jeg skrive en Dockerfile?",
          a: "Nei. Nixpacks leser repoet og bygger image-et. Har du allerede en Dockerfile du er fornøyd med, oppfører et bygg som produserer en Node-server seg likt fra plattformens side.",
        },
        {
          q: "Hvor mye minne får appen min?",
          a: "Det følger planen: 256 MB på gratisplanen, 2 GB på Pro og 8 GB på Business per kjørende app, med mer tilgjengelig under selve byggingen enn i kjøring. Bygger appen din tungt, er det byggeminnet som pleier å være grensen først.",
        },
        {
          q: "Kan jeg deploye uten å pushe?",
          a: "Ja. «Deploy» i dashbordet kjører samme pipeline som en push gjør, på samme gren.",
        },
        {
          q: "Hva skjer med den gamle versjonen?",
          a: "Den serverer trafikken til den nye containeren er helsesjekket og proxyen har byttet over. Først da stoppes og fjernes den.",
        },
      ],
    },
    {
      type: "cta",
      title: "Sett opp det første prosjektet",
      text: "Gratisplanen kjører én app og ubegrenset statiske sider, uten kort.",
      label: "Kom i gang",
    },
  ],
};
