import type { Article } from "./types";

export const hostingOffentligSektorKommune: Article = {
  slug: "hosting-offentlig-sektor-kommune",
  lang: "no",
  title: "Hosting for kommuner og offentlig sektor: hva som må dokumenteres",
  metaTitle: "Hosting for kommune og offentlig sektor | Snoat",
  description:
    "Personvernkonsekvensvurdering, databehandleravtale, tredjelandsoverføring og universell utforming – sjekklista for offentlige nettløsninger, og hvem som svarer på hva.",
  keywords: [
    "hosting offentlig sektor",
    "hosting kommune nettside",
    "personvern kommune",
    "databehandleravtale kommune",
    "skytjenester offentlig sektor",
    "universell utforming nettside krav",
  ],
  category: "compliance",
  published: "2026-08-10",
  related: ["datasuverenitet-norsk-sky", "webhosting-norge-gdpr", "alternativ-til-vercel-norge"],
  lead: "En kommunal nettløsning er sjelden teknisk vanskelig. Det som tar tid er dokumentasjonen: hvem er behandlingsansvarlig, hvor ligger dataene, hvilke underleverandører finnes, hva skjer ved avvik, og er løsningen universelt utformet. Denne artikkelen er lista, med et ærlig svar på hvilke punkter en hostingleverandør faktisk kan hjelpe deg med – og hvilke som blir stående hos dere uansett hva dere kjøper.",
  body: [
    {
      type: "note",
      title: "Ikke juridisk rådgivning",
      text: "Skrevet av folk som drifter en hostingplattform, for folk som skal fylle ut vedleggene. Bruk det som utgangspunkt for samtalen med personvernombudet og innkjøp, ikke som erstatning for den.",
    },
    { type: "h2", text: "Rollene først: dere er behandlingsansvarlig" },
    {
      type: "p",
      text: "Kommunen eller etaten er behandlingsansvarlig for personopplysningene i løsningen. Hostingleverandøren er databehandler og handler på deres instruks. Det betyr at databehandleravtalen etter artikkel 28 skal være på plass før leverandøren behandler personopplysninger, at underleverandører skal være kjent og godkjent, og at ansvaret for å velge en egnet leverandør ligger hos dere. En stor leverandør er ikke et forsvar; en dokumentert vurdering er.",
    },
    { type: "h2", text: "De syv dokumentene som pleier å bli etterspurt" },
    {
      type: "list",
      ordered: true,
      items: [
        "**Databehandleravtale** med underleverandørliste og varslingsplikt ved endringer.",
        "**Protokoll over behandlingsaktiviteter** (artikkel 30) – hvilke kategorier data, hvilke formål, hvor lenge.",
        "**Vurdering av personvernkonsekvenser (DPIA)** når behandlingen sannsynligvis gir høy risiko. En informasjonsside gjør ikke det; et skjema med sensitive opplysninger eller en innsynsløsning gjør det ofte.",
        "**Vurdering av tredjelandsoverføring** dersom noen del av kjeden ligger utenfor EØS – inkludert backup, logger og støtteverktøy.",
        "**Risiko- og sårbarhetsvurdering** av løsningen, med tiltakene som følger av artikkel 32.",
        "**Erklæring om tilgjengelighet** og dokumentasjon på universell utforming.",
        "**Rutine for avviksvarsling**, med den fristen artikkel 33 setter: 72 timer fra dere blir kjent med bruddet.",
      ],
    },
    {
      type: "p",
      text: "Det siste punktet er verdt en linje ekstra, fordi det er det eneste hvor leverandørens interne rutine direkte forbruker deres frist. En databehandler som varsler dere på dag fire har brukt opp klokka dere hadde. Spør om varslingsfristen skriftlig, og få den inn i avtalen.",
    },
    { type: "h2", text: "Tredjelandsoverføring: der de fleste vurderingene stopper" },
    {
      type: "p",
      text: "Ligger personopplysningene i EØS, og kontrolleres systemene av et selskap i EØS, slår kapittel V i personvernforordningen ikke inn. Da finnes det ingen overføring å vurdere, ingen supplerende tiltak å utforme, og ingen beslutning om tilstrekkelig beskyttelsesnivå å være avhengig av. Det er ikke et sterkere argument enn en overføringsvurdering – det er fraværet av argumentet, og det er derfor mange offentlige innkjøpere nå spør om eierskap før de spør om region.",
    },
    {
      type: "p",
      text: "Snoat er et norsk selskap som drifter norsk maskinvare, med databasen på samme infrastruktur som applikasjonene. To eksterne tjenester brukes til plattformens egen drift – en e-postleverandør for konto- og driftspost, og Stripe for betaling ved abonnement – og ingen av dem står i forespørselsveien til løsningen deres. Det er den presise beskrivelsen, og den tåler å bli lest av en jurist.",
    },
    { type: "h2", text: "Universell utforming er et krav, ikke en ambisjon" },
    {
      type: "p",
      text: "Norske nettløsninger rettet mot allmennheten skal følge WCAG 2.1 på nivå AA, med de utvidede kravene som gjelder for offentlig sektor. Tilsynet for universell utforming av IKT fører kontroll, og en erklæring om tilgjengelighet er en del av forventet dokumentasjon. Dette er et krav til løsningen dere bygger, ikke til hostingen – ingen leverandør kan gjøre en utilgjengelig nettside tilgjengelig ved å flytte den. Ta det med i kravspesifikasjonen til den som lager frontenden.",
    },
    { type: "h2", text: "Sporing, statistikk og samtykke" },
    {
      type: "p",
      text: "Samtykke til informasjonskapsler følger av ekomregelverket og handler om hva som lagres på den besøkendes enhet. En offentlig nettside som måler trafikk med et tredjeparts analyseverktøy må derfor både innhente samtykke og forklare hvem som mottar dataene – og et samtykkebanner reduserer datagrunnlaget deres samtidig som det irriterer innbyggerne.",
    },
    {
      type: "p",
      text: "På Snoat kommer trafikkstatistikken fra proxyens egen tilgangslogg. Backend beriker forespørselen, kaster IP-adressen og lagrer bare ferdige aggregater. Ingen sporingskode legges inn i sidene deres, og ingen tredjepart mottar noe – så for vår måling er det ingenting å samtykke til. Skal dere i tillegg bruke et eget analyseverktøy, er det fortsatt deres vurdering å gjøre.",
    },
    { type: "h2", text: "Hva vi ikke har – og som dere skal spørre om" },
    {
      type: "p",
      text: "Troverdighet handler mest om å si det som mangler. Snoat er en ung plattform, og noe av det offentlige anskaffelser ofte etterspør har vi ikke i dag:",
    },
    {
      type: "checks",
      items: [
        { on: true, text: "Norsk selskap, norsk maskinvare, database i samme jurisdiksjon" },
        { on: true, text: "Databehandleravtale og navngitte underleverandører" },
        { on: true, text: "Ingen tredjeparts sporing i løsningen, statistikk uten IP-lagring" },
        { on: true, text: "Utrulling uten nedetid, med tilbakerulling når et bygg feiler" },
        { on: false, text: "ISO 27001-sertifisering" },
        { on: false, text: "Flere geografiske soner med automatisk failover mellom dem" },
        { on: false, text: "Ferdig godkjenning mot Normen for helse- og omsorgssektoren" },
      ],
    },
    {
      type: "p",
      text: "Er noen av de tre nederste et absolutt krav i anskaffelsen, skal dere ikke kjøpe av oss ennå, og vi sier det heller nå enn i et tilbud. Er de ikke det, er de fire øverste ofte nettopp det som er vanskelig å få tak i.",
    },
    {
      type: "faq",
      items: [
        {
          q: "Kan en kommune kjøpe hosting direkte uten konkurranse?",
          a: "Det avhenger av verdien på anskaffelsen og av regelverket som gjelder for terskelen den havner under. Anskaffelser av lav verdi har lettere prosesskrav, men kravet til å kunne dokumentere hvorfor valget er forsvarlig gjelder uansett. Spør innkjøpsfunksjonen hos dere før dere spør leverandøren.",
        },
        {
          q: "Trenger vi DPIA for en informasjonsside?",
          a: "Vanligvis ikke. Kravet utløses av behandling som sannsynligvis medfører høy risiko – særlige kategorier i stor skala, systematisk overvåking, eller profilering med rettslig virkning. Et kontaktskjema er ikke det. En innsyns- eller søknadsløsning kan være det.",
        },
        {
          q: "Hvor ligger backupene?",
          a: "På samme norske infrastruktur. En backup er en kopi av personopplysninger, og en backup i en annen jurisdiksjon er en overføring – spørsmålet er helt på sin plass.",
        },
        {
          q: "Kan vi teste før vi anskaffer?",
          a: "Ja. Gratisplanen kjører én app og ubegrenset antall statiske sider, så en pilot kan settes opp uten en innkjøpsprosess først.",
        },
      ],
    },
    {
      type: "cta",
      title: "Sett opp en pilot før anskaffelsen",
      text: "Gratisplanen holder til å vise løsningen for de som skal godkjenne den.",
      label: "Kom i gang",
    },
  ],
};
