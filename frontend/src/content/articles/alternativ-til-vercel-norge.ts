import type { Article } from "./types";

export const alternativTilVercelNorge: Article = {
  slug: "alternativ-til-vercel-norge",
  lang: "no",
  title: "Alternativ til Vercel i Norge: samme flyt, norsk infrastruktur",
  metaTitle: "Alternativ til Vercel i Norge | Snoat",
  description:
    "Ser du etter et norsk alternativ til Vercel? Her er hva som faktisk skiller et europeisk alternativ fra en europeisk region – og hvor kompromissene ligger.",
  keywords: [
    "alternativ til vercel",
    "norsk alternativ til vercel",
    "vercel norge",
    "hosting av next.js i norge",
    "norsk hostingplattform",
    "deploye fra github norge",
  ],
  category: "comparison",
  published: "2026-09-08",
  related: ["webhosting-norge-gdpr", "datasuverenitet-norsk-sky", "deploye-next-js-i-norge"],
  lead: "Vercel definerte hvordan det skal føles å deploye: koble til et repo, push, og endringen er live. Det er ikke den delen folk vil bort fra. Det er svaret på «hvor ligger dataene, og hvem kan bli pålagt å utlevere dem?» – for stadig flere norske anskaffelser er «us-east-1» ikke et svar som går gjennom.",
  body: [
    {
      type: "p",
      text: "Snoat er en norsk hostingplattform driftet på infrastruktur fra Frostbyte Group AS. Appen din kjører i en isolert container på norsk maskinvare, trafikken går gjennom vår egen omvendte proxy, HTTPS settes opp automatisk, og en push til grenen du har valgt utløser neste utrulling. Utvikleropplevelsen er bevisst gjenkjennelig. Jurisdiksjonen er ikke.",
    },
    { type: "h2", text: "Hva et «norsk alternativ» må bety for å være verdt byttet" },
    {
      type: "p",
      text: "Uttrykket brukes løst. En amerikansk plattform med en region i Frankfurt er ikke det samme som en europeisk leverandør, og en norsk forhandler av amerikansk infrastruktur er det heller ikke. Fire spørsmål skiller markedsføring fra substans:",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "Hvem eier selskapet? Eierskapet avgjør hvilke rettslige pålegg leverandøren må svare på. En regionsinnstilling endrer ikke hvor selskapet hører hjemme.",
        "Hvem eier maskinvaren, og hvor står den? En «europeisk sky» bygget på en amerikansk hyperskalerer arver hyperskalererens eksponering.",
        "Hvor ligger databasen? De fleste flytter appen og lar brukerdataene stå i en amerikansk database – og da er hver rad tilbake der den startet.",
        "Hvilke tredjeparter ser trafikken? Analyse, feilsporing, font-CDN og sesjonsopptak legger hver sin databehandler inn i protokollen din over behandlingsaktiviteter.",
      ],
    },
    {
      type: "p",
      text: "Snoat svarer på alle fire på samme sted: selskapet er norsk, maskinvaren er norsk, databasen er en selvhostet Supabase på samme infrastruktur, og trafikkstatistikken utledes av vår egen proxy-logg. Ingen sporingskode legges inn i prosjektet ditt, og ingen tredjepartsleverandør er involvert i målingen.",
    },
    { type: "h2", text: "Det som ikke skal endres: selve flyten" },
    {
      type: "p",
      text: "Datasuverenitet er lite verdt hvis det koster deg arbeidsflyten. På Snoat kobler du et GitHub-repo gjennom en GitHub App, velger gren, og der er oppsettet. Du skriver ingen Dockerfile: byggemotoren er Nixpacks, som leser kildekoden, kjenner igjen rammeverket og produserer et OCI-image. Push til grenen, og en webhook starter neste deployment.",
    },
    {
      type: "code",
      caption: "Hele deploy-løkka, sett utenfra",
      lines: [
        'git commit -m "fix: avrunding i fakturasummen"',
        "git push origin main",
        "# → bygg → helsesjekk → trafikken byttes. Ingen nedetid.",
      ],
    },
    {
      type: "p",
      text: "Rekkefølgen på den siste linja er hele poenget. Den nye containeren startes ved siden av den som serverer trafikk nå. Den helsesjekkes. Først da bytter proxyen upstream atomisk, og først etter at byttet er bekreftet pensjoneres den gamle containeren. En utrulling koster derfor ingen nedetid, og en utrulling som feiler lar den kjørende versjonen stå – et ødelagt bygg kan ikke ta ned appen din.",
    },
    { type: "h2", text: "Det som faktisk endrer seg med norsk region: avstanden" },
    {
      type: "p",
      text: "Latensargumenter framføres vanligvis med tall noen har funnet på. Her er gulvet i stedet. Lys i fiber går rundt 200 000 km/s, og det setter en hard nedre grense for en rundtur: omtrent 1 ms per 100 km kabel, hver vei. Virkelige ruter er lengre enn luftlinja og legger til svitsjeforsinkelse, så tabellen under er tallet ingen kan slå – ikke tallet du kommer til å måle.",
    },
    {
      type: "table",
      caption: "Teoretisk minste rundtur fra Oslo, luftlinje i fiber",
      head: ["Destinasjon", "Avstand", "Raskest mulige rundtur"],
      rows: [
        ["Norge (samme land)", "≈ 0–500 km", "≈ 0–5 ms"],
        ["Frankfurt", "≈ 1 180 km", "≈ 12 ms"],
        ["Dublin", "≈ 1 230 km", "≈ 12 ms"],
        ["Ashburn, Virginia", "≈ 6 300 km", "≈ 63 ms"],
        ["San Francisco", "≈ 8 600 km", "≈ 86 ms"],
      ],
    },
    {
      type: "note",
      title: "Rundturer multipliseres",
      text: "Én forespørsel er sjelden én rundtur. En kald HTTPS-forbindelse bruker rundturer på DNS, TCP-håndtrykket og TLS-håndtrykket før serveren din ser første byte. Å kutte 60 ms på én rundtur kan derfor være verdt flere hundre millisekunder på første visning for en norsk besøkende – og det er første visning fluktraten reagerer på.",
    },
    { type: "h2", text: "Kompromissene, sagt rett ut" },
    {
      type: "p",
      text: "En plattform med én region i Norge er ikke et globalt kantnettverk, og å late som noe annet ville vært å sløse med tida di. Den ærlige oppdelingen:",
    },
    {
      type: "checks",
      items: [
        {
          on: true,
          text: "Rullerende utrulling uten nedetid, med automatisk tilbakerulling ved feilet bygg",
        },
        { on: true, text: "Automatisk HTTPS, også for eget domene og subdomenene under det" },
        { on: true, text: "Dev-side per gren, passordbeskyttet fra første deployment" },
        {
          on: true,
          text: "Førsteparts trafikkstatistikk fra proxy-loggen – ingen skript i siden, ingen tredjepart",
        },
        {
          on: true,
          text: "Statiske sider servert direkte av proxyen, uten container og uten antallsgrense",
        },
        { on: false, text: "Globalt kantnettverk med tilstedeværelse på alle kontinenter" },
        { on: false, text: "Hundre regioner å velge mellom – regionen er Norge, med vilje" },
        { on: false, text: "Stor markedsplass av ferdige tredjepartsintegrasjoner" },
      ],
    },
    {
      type: "p",
      text: "Er publikummet ditt norsk eller nordisk, er én region i Norge ikke et kompromiss – det er den nærmeste regionen som finnes. Er publikummet ditt reelt globalt, og betyr millisekunder i Sydney mer enn jurisdiksjon, er et globalt kantnettverk riktig verktøy. Da sier vi det.",
    },
    { type: "h2", text: "Slik går en flytting i praksis" },
    {
      type: "list",
      ordered: true,
      items: [
        "Opprett prosjektet og koble til repoet. Snoat kjenner igjen rammeverket; et vanlig Next.js-, Vite-, Astro-, SvelteKit- eller Node-prosjekt trenger ingen konfigurasjon.",
        "Flytt miljøvariablene. Dette er vanligvis det som tar lengst tid, og det er kopier-og-lim.",
        "Deploy til Snoat-subdomenet du får automatisk, og test det ekte oppsettet på et ekte sertifikat.",
        "Pek domenet: A-record på apex og CNAME på www. Sertifikatet utstedes ved første forespørsel, så det er ingen ventetid å planlegge rundt.",
        "Senk TTL dagen før, bytt, og la det gamle oppsettet stå til trafikken har rent ut.",
      ],
    },
    {
      type: "p",
      text: "Databasen er steget folk undervurderer. Å flytte hostingen og la databasen ligge i en amerikansk region løser den minste halvparten av problemet. Snoat kjører en selvhostet Supabase på samme norske infrastruktur, så både innlogging og relasjonsdata havner i samme jurisdiksjon som appen.",
    },
    {
      type: "faq",
      items: [
        {
          q: "Er ikke Vercel GDPR-kompatibelt?",
          a: "Vercel tilbyr databehandleravtale og europeiske regioner, og mange norske selskaper bruker tjenesten lovlig. Bekymringen som driver team til europeiske leverandører er ikke avtalen – det er at et amerikansk-eid selskap kan omfattes av amerikanske pålegg som CLOUD Act uavhengig av hvilken region arbeidslasten kjører i. Om den risikoen er akseptabel, er en vurdering juristene deres må gjøre, og i offentlige anskaffelser er den ofte avgjort av regelverket framfor av preferanse.",
        },
        {
          q: "Må jeg skrive om appen for å flytte fra Vercel?",
          a: "Ikke for et vanlig rammeverksbygg. Bruker appen leverandørspesifikke primitiver – kant-middleware i mange regioner, bildeoptimalisering som tjeneste, eller en proprietær funksjonskjøretid – må de delene erstattes. Et ordinært Next.js-, Vite-, Astro- eller Node-prosjekt bygger og kjører uendret.",
        },
        {
          q: "Hva skjer når en deployment feiler?",
          a: "Ingenting brukerne dine ser. Den nye containeren bygges og helsesjekkes ved siden av den som kjører, og trafikken flyttes først når helsesjekken går gjennom. Et feilet bygg lar forrige versjon servere videre.",
        },
        {
          q: "Hva koster det?",
          a: "Gratisplanen kjører én app med 256 MB minne og 100 byggeminutter i måneden, uten kort. Pro er 199 kr per måned eks. mva. med 10 apper, 2 GB minne per app og prioritert byggekø. Statiske sider er ubegrenset på alle planer. Prisene i dashbordet er alltid fasit – de leses fra de faktiske grensene i backend.",
        },
      ],
    },
    {
      type: "cta",
      title: "Deploy den første appen på norsk infrastruktur",
      text: "Gratisplanen kjører én app uten kort. Koble til et repo og se hvordan flyten kjennes før du flytter noe som betyr noe.",
      label: "Kom i gang",
    },
  ],
};
