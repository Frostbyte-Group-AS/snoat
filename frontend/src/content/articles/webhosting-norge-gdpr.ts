import type { Article } from "./types";

export const webhostingNorgeGdpr: Article = {
  slug: "webhosting-norge-gdpr",
  lang: "no",
  title: "GDPR-trygg hosting: sjekklista leverandøren din bør kunne svare på",
  metaTitle: "GDPR-trygg hosting i Norge – sjekkliste | Snoat",
  description:
    "GDPR er ikke et merke en leverandør kan selge deg. Her er de tolv spørsmålene du bør stille en hostingleverandør, og hva et godt svar ser ut som.",
  keywords: [
    "gdpr hosting",
    "webhosting norge",
    "norsk hosting gdpr",
    "databehandleravtale hosting",
    "personopplysninger sky",
    "hosting i norge",
  ],
  category: "compliance",
  published: "2026-09-05",
  related: [
    "alternativ-til-vercel-norge",
    "datasuverenitet-norsk-sky",
    "hosting-offentlig-sektor-kommune",
  ],
  lead: "Ingen hostingleverandør kan gjøre deg GDPR-kompatibel, og en leverandør som sier noe annet selger deg noe. Etterlevelse er en egenskap ved hvordan du behandler personopplysninger – hostingen er én databehandler i den kjeden. Det en god leverandør kan gjøre, er å svare på et konkret sett spørsmål skriftlig, uten et salgsmøte. Her er lista, og hva et ekte svar høres ut som.",
  body: [
    {
      type: "note",
      title: "Ikke juridisk rådgivning",
      text: "Dette er en teknisk sjekkliste skrevet av folk som drifter en hostingplattform, ikke en juridisk vurdering. Der svaret endrer hva du skriver i en DPIA eller i protokollen over behandlingsaktiviteter, involver personvernombudet eller en advokat.",
    },
    { type: "h2", text: "Først: få rollene på plass" },
    {
      type: "p",
      text: "Etter personvernforordningen er du nesten alltid behandlingsansvarlig for brukernes data, og hostingleverandøren er databehandler som handler på dine instrukser (artikkel 28). Det har to umiddelbare konsekvenser: du må ha en databehandleravtale på plass før leverandøren behandler personopplysninger, og du er ansvarlig for at leverandøren er egnet. «Vi bruker en stor leverandør» er ikke et forsvar. «Vi vurderte leverandøren mot disse kriteriene» er det.",
    },
    { type: "h2", text: "De tolv spørsmålene" },
    {
      type: "list",
      ordered: true,
      items: [
        "Hvor lagres dataene fysisk? Et land, ikke et regionsnavn fra markedsavdelingen.",
        "Hvem eier selskapet, og hvor er det registrert? Det avgjør hvilke rettslige pålegg det kan bli møtt med.",
        "Finnes databehandleravtalen uten forhandling, og navngir den underleverandørene?",
        "Hva er den fullstendige lista over underleverandører, og hvordan varsles endringer?",
        "Forlater noen personopplysninger EØS – også i backup, logger og støtteverktøy?",
        "Hvor lenge lagres tilgangslogger, og inneholder de IP-adresser? En IP-adresse er en personopplysning.",
        "Hvilken analyse kjører som standard, og legges det noe inn i sidene mine?",
        "Hvor ligger backupene, og kan de gjenopprettes innenfor samme jurisdiksjon?",
        "Krypteres data under overføring, og hva skjer med dem i ro?",
        "Hvordan får jeg full eksport, og hvordan får jeg bekreftet sletting?",
        "Hvordan og hvor raskt varsles jeg om avvik? Du har 72 timer etter artikkel 33; en databehandler som melder på dag fire har brukt opp fristen din.",
        "Hvem hos leverandøren kan teknisk lese dataene mine, og hva hindrer det?",
      ],
    },
    { type: "h2", text: "De to spørsmålene folk glemmer" },
    { type: "h3", text: "Loggene dine er personopplysninger" },
    {
      type: "p",
      text: "Tilgangsloggene til en webserver inneholder IP-adresser, og en IP-adresse er en personopplysning – det avgjorde EU-domstolen i Breyer-saken. Da er lagringstid på logger en behandlingsbeslutning, ikke en driftsdetalj. Spør om tallet. Er svaret «for alltid», er det et funn.",
    },
    {
      type: "p",
      text: "På Snoat kommer trafikkstatistikken fra vår egen proxys tilgangslogg, som strømmes til backend over et internt Docker-nett. Backend beriker forespørselen, kaster IP-adressen og skriver bare ferdige aggregater til databasen. Ingen tredjepartsleverandør er i veien, og ingen sporingskode legges inn i prosjektet ditt – som også betyr at de besøkende ikke har noe å samtykke til for vår måling.",
    },
    { type: "h3", text: "Databasen er som regel den reelle eksponeringen" },
    {
      type: "p",
      text: "Team flytter frontenden til en europeisk leverandør, føler seg tryggere, og lar databasen – der navn, e-postadresser og ordrehistorikk faktisk ligger – stå i en amerikansk tjeneste. Applaget er den minste halvparten av problemet. Snoat kjører en selvhostet Supabase på samme norske infrastruktur, så innlogging og relasjonsdata ligger i samme jurisdiksjon som appen som leser dem.",
    },
    { type: "h2", text: "Overføring til tredjeland, kort fortalt" },
    {
      type: "p",
      text: "Går personopplysninger til et land utenfor EØS, gjelder kapittel V i forordningen. Da trenger du en beslutning om tilstrekkelig beskyttelsesnivå, eller standard personvernbestemmelser pluss en overføringsvurdering. EU–US Data Privacy Framework gir en slik vei for sertifiserte amerikanske mottakere, men det er den tredje ordningen i sitt slag på et tiår – Safe Harbour og Privacy Shield ble begge kjent ugyldige – og den er utfordret rettslig. Å bygge en arkitektur som forutsetter at dagens ordning står, er et veddemål, og det er verdt å kalle det det.",
    },
    {
      type: "p",
      text: "Alternativet er ikke eksotisk: forlater dataene aldri EØS, slår ikke kapittel V inn, og overføringsvurderingen er én linje i stedet for et prosjekt.",
    },
    { type: "h2", text: "Hva vi kan og ikke kan påstå om oss selv" },
    {
      type: "p",
      text: "Presisjon er mer verdt enn et merke her, så: kildekoden din, applikasjonsdataene, databasen og trafikkloggene for appene dine ligger på norsk infrastruktur driftet av Frostbyte Group AS. To eksterne tjenester brukes til plattformens egen drift, ikke til brukertrafikken din – en e-postleverandør for konto- og driftspost, og Stripe for betaling dersom du abonnerer. Begge er navngitt, og ingen av dem står i forespørselsveien til applikasjonen din.",
    },
    {
      type: "checks",
      items: [
        { on: true, text: "Applikasjonsdata, database og trafikklogger på norsk infrastruktur" },
        { on: true, text: "Statistikk utledet av vår egen proxy-logg, IP kastet før lagring" },
        { on: true, text: "Ingen sporingskode legges i prosjektet ditt" },
        {
          on: true,
          text: "Rad-nivå sikkerhet i databasen, så en klient bare kan lese sine egne rader",
        },
        {
          on: false,
          text: "Et løfte om at du blir etterlevende av å bruke oss – det kan ingen leverandør selge",
        },
      ],
    },
    {
      type: "faq",
      items: [
        {
          q: "Er Vercel GDPR-kompatibelt?",
          a: "Vercel publiserer databehandleravtale og tilbyr europeiske regioner, og mange norske selskaper bruker tjenesten lovlig. Det åpne spørsmålet er ikke papirene, men jurisdiksjonen: en amerikansk-eid leverandør kan omfattes av amerikanske pålegg som CLOUD Act uavhengig av hvilken region arbeidslasten kjører i. Om den restrisikoen er akseptabel for dine data, er en vurdering du gjør som behandlingsansvarlig – og i regulerte eller offentlige anskaffelser avgjøres den ofte av regelverket framfor av preferanse.",
        },
        {
          q: "Trenger jeg DPIA for å hoste en nettside?",
          a: "Vanligvis ikke. En vurdering av personvernkonsekvenser kreves når behandlingen sannsynligvis medfører høy risiko for enkeltpersoner – særlige kategorier i stor skala, systematisk overvåking, profilering med rettslig virkning. En ordinær markedsside med kontaktskjema kvalifiserer ikke. En pasientportal gjør det.",
        },
        {
          q: "Slipper jeg cookie-banner med norsk hosting?",
          a: "Nei. Krav om samtykke til informasjonskapsler følger av ekomloven og ePrivacy, og handler om å lagre informasjon på den besøkendes enhet – ikke om hvor serveren står. Det en førsteparts, logg-basert måling unngår, er behovet for samtykke til selve målingen, fordi ingenting lagres på enheten og ingen tredjepart mottar dataene.",
        },
        {
          q: "Hvor ligger backupene?",
          a: "På samme norske infrastruktur. En backup er en kopi av personopplysninger, og en backup i en annen jurisdiksjon er en overføring – å spørre om det er helt riktig.",
        },
      ],
    },
    {
      type: "cta",
      title: "Kjør sjekklista på oss",
      text: "Start et gratis prosjekt og se svarene i produktet framfor i en brosjyre.",
      label: "Kom i gang",
    },
  ],
};
