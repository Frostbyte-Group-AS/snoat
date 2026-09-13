import type { Article } from "./types";

export const datasuverenitetNorskSky: Article = {
  slug: "datasuverenitet-norsk-sky",
  lang: "no",
  title: "Datasuverenitet i praksis: hva «norsk sky» faktisk betyr",
  metaTitle: "Datasuverenitet: hva «norsk sky» betyr | Snoat",
  description:
    "Datalagring i Norge er ikke det samme som datasuverenitet. De tre nivåene, hva CLOUD Act endrer, og hvilke dører data faktisk forlater landet gjennom.",
  keywords: [
    "datasuverenitet",
    "norsk sky",
    "cloud act norge",
    "digital suverenitet",
    "datalagring i norge",
    "norsk skytjeneste",
  ],
  category: "compliance",
  published: "2026-09-02",
  related: [
    "webhosting-norge-gdpr",
    "hosting-offentlig-sektor-kommune",
    "alternativ-til-vercel-norge",
  ],
  lead: "«Vi valgte regionen i Frankfurt» er et svar på et spørsmål om latens. Det er ikke i seg selv et svar på et spørsmål om jurisdiksjon. Forskjellen har et navn i anskaffelsesdokumentene – datalagring mot datasuverenitet – og den er grunnen til at stadig flere norske innkjøpere spør hvem som eier leverandøren før de spør hvor serverne står.",
  body: [
    {
      type: "note",
      title: "Ikke juridisk rådgivning",
      text: "Skrevet av folk som drifter en hostingplattform, for folk som skal fylle ut et sikkerhetsskjema. Der det berører en beslutning, legg det fram for juristen eller personvernombudet.",
    },
    { type: "h2", text: "Tre nivåer, og hvorfor de blandes sammen" },
    {
      type: "table",
      head: ["Nivå", "Hva det betyr", "Hva det ikke dekker"],
      rows: [
        [
          "Datalagring (residency)",
          "Bytene ligger i et valgt land eller en valgt region.",
          "Hvem som kan pålegges å gi tilgang, og hvem som administrerer maskinene.",
        ],
        [
          "Driftssuverenitet",
          "Bare personell i den valgte jurisdiksjonen har teknisk tilgang til systemene.",
          "Pålegg morselskapet kan bli møtt med i sitt eget hjemland.",
        ],
        [
          "Jurisdiksjonell suverenitet",
          "Leverandøren er registrert og kontrollert i jurisdiksjonen, så bare dens rett gjelder.",
          "Ingenting videre – dette er nivået regelverket i økende grad etterspør.",
        ],
      ],
    },
    {
      type: "p",
      text: "De fleste «europeisk sky»-tilbudene leverer det første nivået, noen leverer det andre, og det tredje krever et selskap som ikke er eid utenfor jurisdiksjonen. Å vite hvilket nivå du har kjøpt, er mesteparten av jobben.",
    },
    { type: "h2", text: "Hva CLOUD Act faktisk sier" },
    {
      type: "p",
      text: "Den amerikanske CLOUD Act fra 2018 endret Stored Communications Act slik at det står uttrykkelig at en amerikansk leverandør må utlevere data den har i «possession, custody, or control» ved gyldig rettslig pålegg – uavhengig av hvilket land dataene er lagret i. Loven kom for å avgjøre Microsoft Ireland-saken, der nøyaktig det spørsmålet lå til behandling i høyesterett.",
    },
    {
      type: "p",
      text: "To konsekvenser følger. For det første fjerner lagring i en europeisk region ikke plikten, fordi plikten henger på selskapet og ikke på disken. For det andre kan leverandøren være forhindret fra å fortelle deg at et pålegg kom – så et tomt punkt i en åpenhetsrapport er ikke bevis for noe.",
    },
    { type: "h2", text: "Hva Schrems II avgjorde" },
    {
      type: "p",
      text: "I juli 2020 kjente EU-domstolen Privacy Shield ugyldig (sak C-311/18). Begrunnelsen handlet ikke om papirarbeid, men om amerikansk overvåkingsrett – særlig rekkevidden av FISA § 702 og mangelen på effektivt rettsmiddel for europeiske borgere. Standard personvernbestemmelser overlevde, men med et vilkår: eksportøren må vurdere om retten i mottakerlandet undergraver bestemmelsene, og legge til supplerende tiltak hvis den gjør det. Den vurderingen er overføringsvurderingen som nå ligger i mange norske etterlevelsesmapper.",
    },
    {
      type: "p",
      text: "I juli 2023 vedtok Kommisjonen en beslutning om tilstrekkelig beskyttelsesnivå for EU–US Data Privacy Framework, som igjen gir en lovlig overføringsvei til sertifiserte amerikanske mottakere. Det er den tredje ordningen i sitt slag på et tiår, og den er utfordret rettslig. Forutsetter arkitekturen din at den fortsatt står om fem år, er den forutsetningen en avhengighet det er verdt å skrive ned ved siden av de andre.",
    },
    { type: "h2", text: "Norge, EØS og hvorfor det er enklere enn folk tror" },
    {
      type: "p",
      text: "Norge er ikke i EU, men er i EØS, og personvernforordningen gjelder gjennom EØS-avtalen – gjennomført nasjonalt i personopplysningsloven. Data lagret i Norge er derfor ikke en tredjelandsoverføring for en europeisk behandlingsansvarlig, og kapittel V slår ikke inn. Det er ikke et sterkere juridisk argument enn en overføringsvurdering; det er fraværet av argumentet.",
    },
    { type: "h2", text: "Dørene dataene faktisk går ut av landet gjennom" },
    {
      type: "p",
      text: "I en typisk moderne webapplikasjon forlater personopplysninger EØS gjennom flere dører enn hostingfakturaen antyder. Inventaret er nesten alltid lengre enn folk tror:",
    },
    {
      type: "list",
      items: [
        "Den administrerte databasen, som ofte er det første som plukkes fra en amerikansk markedsplass.",
        "Feilsporing, som sender stacktracer med brukeridentifikatorer og av og til hele forespørselskropper.",
        "Produktanalyse og sesjonsopptak, som er laget for å fange atferd i detalj.",
        "Transaksjonell e-post, som per definisjon behandler adresser og innhold.",
        "CDN for fonter, skript og ikoner, som ser den besøkendes IP-adresse ved hver sidevisning.",
        "CI-en, som kloner repoet og gjerne holder produksjonshemmelighetene.",
        "AI-API-et du la inn i forrige kvartal, som nå mottar alt prompten din inneholder.",
      ],
    },
    {
      type: "p",
      text: "Snoat fjerner de dørene som ligger i hostingen: appen kjører i en container på norsk infrastruktur, databasen er en selvhostet Supabase på samme infrastruktur, byggene kjører på vår egen byggemotor framfor en tredjeparts CI, og trafikkstatistikken regnes ut fra vår egen proxy-logg med IP-adressen kastet før lagring. De øvrige dørene er dine å lukke – og å kjenne lista er måten man lukker dem.",
    },
    { type: "h2", text: "Spørsmål verdt å ta med i et sikkerhetsskjema" },
    {
      type: "list",
      ordered: true,
      items: [
        "I hvilket land er avtalepartneren registrert, og hvem er ytterste eier?",
        "Hvilket av de tre suverenitetsnivåene over leverer tilbudet, med leverandørens egne ord?",
        "Kan noen enhet utenfor EØS i konsernet teknisk nå produksjonssystemer eller backup?",
        "Bygger dere på Data Privacy Framework, standard personvernbestemmelser, eller ingen av dem?",
        "Hva er prosessen hvis dere mottar et utenlandsk rettslig pålegg om mine data, og hva får jeg vite?",
      ],
    },
    {
      type: "faq",
      items: [
        {
          q: "Betyr CLOUD Act at amerikansk sky er ulovlig i Norge?",
          a: "Nei. Å bruke en amerikansk leverandør er lovlig, og store deler av norsk næringsliv gjør det daglig. Det CLOUD Act skaper er en restrisiko som den behandlingsansvarlige må vurdere og dokumentere framfor å forutsette bort. Regulerte sektorer og offentlige virksomheter konkluderer ofte med at risikoen ikke er akseptabel for bestemte datakategorier; en markedsside konkluderer vanligvis motsatt.",
        },
        {
          q: "Holder det med et norsk datterselskap av en amerikansk leverandør?",
          a: "Ikke i seg selv. Spørsmålet er om morselskapet har besittelse, forvaring eller kontroll over dataene – noe som typisk avhenger av hvem som administrerer systemene og holder nøklene. Suverene sky-ordninger forsøker å kutte nøyaktig den koblingen, og detaljene betyr svært mye.",
        },
        {
          q: "Er kryptering nok?",
          a: "Kryptering er nødvendig og ikke tilstrekkelig. Den hjelper reelt når leverandøren faktisk ikke kan nå nøklene. Forvalter samme leverandør både nøkkelen og teksten, kan et pålegg nå begge.",
        },
        {
          q: "Hvor ligger Snoats infrastruktur?",
          a: "På maskinvare i Norge, driftet av Frostbyte Group AS. Selskapet er norsk, maskinvaren er norsk, og databasen ligger på samme infrastruktur som appene.",
        },
      ],
    },
    {
      type: "cta",
      title: "Ta overføringsspørsmålet ut av arkitekturen",
      text: "Deploy på norsk infrastruktur, med databasen på samme sted som appen.",
      label: "Kom i gang",
    },
  ],
};
