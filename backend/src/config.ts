import { z } from "zod";

/**
 * Valgfri variabel som også tåler tom streng.
 *
 * `.optional()` godtar kun `undefined`, men docker-compose sender `""` for en
 * variabel som ikke er satt (`${FOO:-}`). Uten denne krasjer backend i oppstart
 * med «String must contain at least 1 character» så snart en valgfri integrasjon
 * ikke er konfigurert.
 */
const optionalEnv = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** Intern URL til Supabase-gatewayen (Kong). */
  SUPABASE_URL: z.string().url(),
  /** Service-role-nøkkel: omgår RLS. Skal aldri eksponeres mot frontend. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),

  /** Caddy sitt admin-API – her opprettes rutene for deployede apper. */
  CADDY_ADMIN_URL: z.string().url().default("http://caddy:2019"),

  /**
   * Porten Caddy strømmer access-loggen til.
   *
   * Kun på `snoat`-nettverket – aldri i `ports:`. Alt som når denne porten kan
   * dikte opp trafikk for et hvilket som helst prosjekt.
   */
  SNOAT_ANALYTICS_INGEST_PORT: z.coerce.number().int().positive().default(3100),

  /**
   * Hvor lenge treff samles i minnet før de skrives.
   *
   * Hele poenget med bufferet er at en app med 300 000 treff i timen blir én
   * rad i stedet for 300 000 INSERT-er. Høyere verdi gir færre skrivinger, men
   * mer som går tapt hvis prosessen dør brått.
   */
  SNOAT_ANALYTICS_FLUSH_MS: z.coerce.number().int().positive().default(5_000),

  /**
   * Tidssonen døgnskillet i statistikken følger.
   *
   * «I dag» skal bety norsk døgn for en norsk kunde – med UTC ville dagen
   * begynt kl. 01:00 om vinteren og 02:00 om sommeren.
   */
  SNOAT_ANALYTICS_TIMEZONE: z.string().default("Europe/Oslo"),

  /**
   * Levetid for besøkende-hasher og for aggregatene (GDPR art. 5 nr. 1 e).
   *
   * Hashene har kortest levetid fordi de er det eneste som er per-person, selv
   * om de er anonymisert. Aggregatene er ren statistikk uten personkobling og
   * kan leve lenger – 400 dager gir sammenligning mot i fjor.
   */
  SNOAT_ANALYTICS_VISITOR_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  SNOAT_ANALYTICS_ROLLUP_RETENTION_DAYS: z.coerce.number().int().positive().default(400),

  /**
   * Feilsporing.
   *
   * Flush-vinduet er lengre enn analytikkens fem sekunder med vilje: feil kommer
   * i klynger, og et lengre vindu betyr at en app som krasjer for hundre
   * brukere samtidig blir én rad å skrive i stedet for tjue.
   */
  SNOAT_ERRORS_FLUSH_MS: z.coerce.number().int().positive().default(15_000),

  /**
   * Hvor ofte containernes stderr leses etter ufangede unntak.
   *
   * Ett minutt er valgt fordi det som leser dette er et menneske om morgenen
   * eller en agent kl. 05:00 – ikke en vaktordning. Kortere intervall ville kostet
   * ett Docker-kall per app hvert intervall uten at noen fikk vite noe tidligere.
   */
  SNOAT_ERRORS_STDERR_SWEEP_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Levetid for stacktraces og for lukkede grupper.
   *
   * En stacktrace er det mest sensitive vi lagrer – den kan inneholde hva som
   * helst appen hadde i minnet – og har derfor kortest levetid av alt i
   * plattformen. `EVENTS_PER_GROUP` er den harde grensen: uansett alder beholdes
   * kun de nyeste per feilgruppe, slik at én app i krasj-løkke ikke kan fylle
   * disken mellom to oppryddinger.
   *
   * Åpne feilgrupper slettes aldri. En feil ingen har rettet er fortsatt en
   * feil, uansett hvor gammel den er.
   */
  SNOAT_ERRORS_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  SNOAT_ERRORS_EVENTS_PER_GROUP: z.coerce.number().int().positive().default(20),
  SNOAT_ERRORS_RESOLVED_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  /**
   * Sti til MMDB-databasen for landoppslag. Valgfri – uten den fungerer alt
   * som før, men uten landstatistikk. Hentes med `scripts/fetch-geoip.mjs`.
   */
  SNOAT_GEOIP_DB_PATH: optionalEnv,
  /** Suffikset hvert prosjekt får sitt subdomene under. */
  SNOAT_APP_DOMAIN_SUFFIX: z.string().default(".snoat.localhost"),
  /**
   * A-record-målet kundene peker sine egne domener mot.
   *
   * Backend trenger fasiten for å kunne svare på om et domene faktisk peker hit.
   * Uten den kan DNS-fanen bare gjenta hva kunden *skal* sette, ikke om det er
   * gjort – og det er nettopp forskjellen mellom «virker ikke» og «venter på at
   * DNS propagerer».
   */
  SNOAT_SERVER_IP: z.string().default("127.0.0.1"),
  /** Docker-nettverket brukerapplikasjoner kobles til, slik at Caddy når dem. */
  SNOAT_APPS_NETWORK: z.string().default("snoat_apps"),
  /**
   * Absolutt sti der repoer klones og bygges.
   *
   * Må være identisk på host og i containeren: nixpacks sender stien videre til
   * host-maskinens Docker-daemon som build-context, og daemonen løser den i
   * sitt eget filsystem – ikke i vårt.
   */
  SNOAT_WORKSPACE_DIR: z.string().min(1),

  /**
   * Katalogen ferdigbygde statiske sider legges i.
   *
   * Må være det **samme volumet** i backend og i Caddy: backend skriver filene,
   * Caddy serverer dem. I motsetning til SNOAT_WORKSPACE_DIR er det ingen
   * host-daemon inne i bildet her, så et navngitt Docker-volum holder – stien
   * trenger bare være lik i de to containerne.
   */
  SNOAT_SITES_DIR: z.string().min(1).default("/srv/sites"),

  /**
   * Hvor mange tidligere versjoner av en statisk side som beholdes på disk.
   *
   * Filene er små og allerede bygget, så det å beholde noen versjoner er
   * praktisk talt gratis – og det gjør tilbakerulling til et rutebytte i stedet
   * for en ny build.
   */
  SNOAT_STATIC_KEEP_VERSIONS: z.coerce.number().int().positive().default(3),

  DOCKER_HOST: z.string().default("unix:///var/run/docker.sock"),

  /**
   * Origin dashboardet kjører på – eneste tillatte CORS-origin.
   *
   * Kommaseparert liste. Den **første** er den kanoniske: MCP-connectoren sender
   * kunden til samtykkesiden der (`lib/public-url.ts`).
   */
  SNOAT_FRONTEND_ORIGIN: z.string().default("http://localhost:8080"),

  /**
   * Overstyring av backends egen offentlige URL, f.eks. `https://api.snoat.com`.
   *
   * Valgfri, og bør normalt stå tom: uten den leses URL-en ut av `Host` og
   * `X-Forwarded-Proto` på forespørselen, som er riktig i alle miljøer uten at
   * noen må huske å sette en variabel. Sett den bare dersom backend står bak noe
   * som ikke videresender de headerne. Se `lib/public-url.ts` for hvorfor
   * OAuth-metadataen ikke tåler en feil verdi her.
   */
  SNOAT_PUBLIC_API_URL: optionalEnv,

  /**
   * Porten brukerapplikasjoner forventes å lytte på inne i containeren.
   * Injiseres som `PORT`, etter samme konvensjon som Heroku og Railway.
   */
  SNOAT_APP_PORT: z.coerce.number().int().positive().default(3000),

  /**
   * Hvor lenge en ny container må ha kjørt sammenhengende før trafikken flyttes
   * til den. Se `assertStillRunning()` i services/containers.ts.
   *
   * Verdien er en avveining, ikke en konstant: for lav slipper en app som
   * krasjer under oppstart rett gjennom, for høy forsinker hver vellykket
   * deployment. 15 sekunder er valgt fordi en container på 0,5 CPU bruker
   * flere sekunder bare på å komme gjennom `npm run start` før den rekker å
   * krasje — og det var nettopp den timingen som gjorde at en app i krasj-loop
   * ble meldt som «Live».
   */
  SNOAT_STABLE_FOR_MS: z.coerce.number().int().positive().default(15_000),

  /**
   * Taket på hvor lenge vi venter på at containeren skal bli stabil. Nås det,
   * feiler deploymenten framfor å henge — en app som starter, kjører litt,
   * krasjer, og starter igjen, blir aldri stabil.
   */
  SNOAT_STABLE_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  /**
   * Ressurstak per applikasjonscontainer. Dette er mekanismen som gjør
   * gratisplanen mulig uten at ett prosjekt kan spise opp verten
   * (01_vision_and_brand.md).
   */
  SNOAT_APP_MEMORY_MB: z.coerce.number().int().positive().default(512),
  SNOAT_APP_CPUS: z.coerce.number().positive().default(1),

  /**
   * Maks antall ganger Docker selv starter en applikasjonscontainer på nytt
   * etter et krasj, før den gir opp og lar containeren stå stoppet.
   *
   * ── HVORFOR IKKE `unless-stopped` LENGER ────────────────────────────────
   * Fram til containerhelse-sveipet (`services/helse.ts`) kom på plass hadde
   * containere `RestartPolicy: unless-stopped` – Docker startet en krasjende
   * app på nytt i det uendelige, uten tak og uten at noen fikk vite det.
   * En container som dør av forbigående minnemangel bør komme opp igjen av seg
   * selv, men en som krasjer i loop (feil i koden, en manglende
   * miljøvariabel) skal ikke restarte for alltid i stillhet – det var nettopp
   * den stillheten som gjorde at `eierfullstack` sto som «Live» i produksjon
   * lenge etter at appen var død.
   *
   * `on-failure:N` gir det beste av begge: forbigående krasj (OOM, en
   * restart av verten) rettes automatisk innenfor de første forsøkene, mens en
   * app som fortsetter å krasje gir opp etter N ganger og blir stående stoppet
   * – synlig for `helse.ts`, som oppdager at containeren er borte og retter
   * tilstanden i basen i stedet for at den blir stående og lyve.
   *
   * Docker nullstiller ikke telleren over tid – kun en ny container (altså en
   * ny deployment) gjør det. Et prosjekt som krasjer sjelden, men over lang
   * nok tid, kan derfor til slutt slutte å restarte helt av seg selv også.
   * Det er en bevisst avveining: helsesveipet er sikkerhetsnettet uansett
   * årsak, og et ubegrenset antall restarter er nøyaktig risikoen vi tar bort.
   */
  SNOAT_APP_RESTART_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),

  /**
   * Hvor ofte helsesveipet (`services/helse.ts`) sammenligner det databasen
   * påstår kjører mot det Docker faktisk har.
   *
   * `assertStillRunning()` ser bare på containeren i sekundene rundt en
   * utrulling. Dør containeren en time senere – OOM, krasj-loop som til slutt
   * ga opp, eller noen som fjernet den manuelt – oppdaget ingenting det før
   * dette sveipet: `reconcileRoutes()` kjører kun ved backend-oppstart, og en
   * app kunne stå som `success`/Live i basen og i dashboardet i dagevis mens
   * den svarte 502. To minutter er hyppig nok til at et kundemerkbart avbrudd
   * oppdages i god tid før noen rekker å lure på hvorfor siden er nede, uten
   * å spørre Docker oftere enn nødvendig.
   */
  SNOAT_HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(2 * 60 * 1000),

  /**
   * Hvor lenge den forrige containeren får på seg å fullføre forespørsler den
   * holder på, etter at Caddy har flyttet ny trafikk til den nye versjonen
   * (SIGTERM → SIGKILL). Gjør den siste delen av en rullerende utrulling myk.
   */
  SNOAT_APP_STOP_TIMEOUT_S: z.coerce.number().int().nonnegative().default(10),

  /**
   * Maks tid en enkelt build får bruke før den avbrytes.
   *
   * Merk at dette er en timer inne i backend-prosessen. Går hele verten tom for
   * minne, blir også backend utsultet, og timeren fyrer ikke – en vakt som deler
   * skjebne med det den vokter er ingen vakt. Det er `SNOAT_MAX_CONCURRENT_BUILDS`
   * og swap som faktisk hindrer den situasjonen.
   */
  SNOAT_BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),

  /**
   * Hvor mange prosjekter som får bygges samtidig på hele verten.
   *
   * En nix-build tar det minnet den trenger. To samtidige på en liten VPS spiser
   * hele maskinen, og siden Postgres og Caddy står på samme boks, går plattformen
   * ned med dem (`09_production_deployment.md`). Standard er 1 – hev den først
   * når verten har minne å avse.
   */
  SNOAT_MAX_CONCURRENT_BUILDS: z.coerce.number().int().positive().default(1),

  /**
   * Heap-tak for Node under *bygging*, i MB. Injiseres som `NODE_OPTIONS
   * --max-old-space-size` når prosjektet ikke setter den selv.
   *
   * `next build` og `vite build` tar så mye minne de får lov til. Uten et tak er
   * det verten som setter grensen, og da er det for sent. Med taket feiler bygget
   * i stedet med «JavaScript heap out of memory» – en feil som rammer én kunde og
   * står forklart i loggen, i stedet for å ta ned alle.
   *
   * ── DETTE ER ET TAK, IKKE EN VERDI ──────────────────────────────────────
   *
   * Fram til 6. september 2026 var dette tallet selve byggeminnet, likt for
   * alle planer. En betalende kunde fikk dermed nøyaktig samme byggetak som en
   * gratisbruker: planen ga flere apper og mer kjøreminne, men ikke én megabyte
   * mer å bygge med. For et prosjekt som var for stort til å bygge, hjalp det
   * ikke å betale.
   *
   * Byggeminnet er nå en PLANGRENSE (`buildMemoryMb` i `services/plans.ts`).
   * Denne variabelen er vertens tak: planen ber om et tall, og det laveste av
   * de to vinner. Kjører Snoat på en liten VPS, senkes den her — et tak vi ikke
   * kan innfri er verre enn et lavt.
   *
   * Standard 8192 slipper business-planen helt gjennom på en vert som har
   * minne til det. Byggene er serialisert (`SNOAT_MAX_CONCURRENT_BUILDS`) og
   * varer i minutter, så et bygg kan låne mye mer enn en app som står døgnet
   * rundt kan binde opp.
   */
  SNOAT_BUILD_NODE_MEMORY_MB: z.coerce.number().int().positive().default(8192),

  /**
   * Node-versjonen prosjekter bygges med når repoet ikke oppgir en selv.
   *
   * Nixpacks faller tilbake på Node 18, som er ute av vedlikehold og ikke kan
   * bygge moderne Next.js eller Vite. Se `runtime-versions.ts`.
   *
   * Kun major-nummeret teller. Nixpacks slår opp majoren i en tabell over
   * nixpkgs-pins (14, 16, 18, 20, 22, 24 – lista varierer med Nixpacks-versjon)
   * og bygger med `nodejs_<major>`. Minor og patch kastes: «22.13» gir nøyaktig
   * samme Node som «22», nemlig den 22.x den pinnede nixpkgs-en tilfeldigvis
   * inneholder. Vil du ha en nyere 22.x, er det Nixpacks som må oppgraderes –
   * denne verdien kan ikke styre det.
   *
   * ⚠️ En major Nixpacks ikke kjenner gir ingen feil. Den faller stille tilbake
   * til `nodejs_18`, altså det stikk motsatte av hensikten. Sjekk derfor mot den
   * installerte Nixpacks-versjonen før du hever denne, og bekreft i byggeloggen
   * at «Node-versjon» og pakken under `setup` faktisk stemmer.
   */
  SNOAT_DEFAULT_NODE_VERSION: z.string().min(1).default("22"),

  /**
   * GitHub App – lar brukeren velge repository fra en liste og deploye private
   * repoer. Valgfri: uten disse faller dashboardet tilbake til å lime inn URL,
   * og `/api/github/*` svarer 503.
   *
   * Den private nøkkelen er base64-kodet fordi en PEM inneholder linjeskift som
   * hverken .env eller docker-compose håndterer pent:
   *   base64 -i snoat.<dato>.private-key.pem
   */
  GITHUB_APP_ID: optionalEnv,
  GITHUB_APP_PRIVATE_KEY: optionalEnv,
  /** Slug-en i https://github.com/apps/<slug> – brukes i installasjons-URL-en. */
  GITHUB_APP_SLUG: optionalEnv,
  /** Signerer `state` gjennom installasjonsredirecten. Genereres av bootstrap. */
  GITHUB_APP_STATE_SECRET: optionalEnv,
  /**
   * Webhook-secret for automatisk deploy ved push. Må være den *samme* verdien
   * som står i App-ens webhook-innstillinger på github.com – i motsetning til
   * hemmelighetene over er dette en delt verdi, ikke en vi kan generere fritt.
   *
   * Valgfri, slik at oppsettet kan prøves ut før secreten er på plass. Er den
   * tom, tas webhooks imot uverifisert – og da kan hvem som helst starte builds.
   * Se `CONTEXT_FOR_AI/08_security_model.md`.
   */
  GITHUB_WEBHOOK_SECRET: optionalEnv,

  /**
   * Stripe – abonnement, betaling og kundeportal.
   *
   * Valgfri, på samme måte som GitHub App-en: uten `STRIPE_SECRET_KEY` svarer
   * `/api/billing/checkout` og `/api/billing/portal` 503, og dashboardet viser
   * planen som «Free» uten oppgraderingsknapp. Plattformen fungerer ellers som
   * før – planhåndhevingen leser Supabase, ikke Stripe.
   */
  STRIPE_SECRET_KEY: optionalEnv,

  /**
   * Signaturhemmeligheten for webhook-endepunktet (`whsec_…`).
   *
   * I motsetning til `STRIPE_SECRET_KEY` er dette en verdi Stripe genererer per
   * endepunkt – den fra `stripe listen` lokalt er en annen enn den i dashboardet
   * deres. Er den tom, **avvises alle webhooks med 503**. Det er motsatt av
   * hvordan GitHub-webhooken oppfører seg uten secret, og det er med vilje: en
   * uverifisert GitHub-webhook starter et bygg, mens en uverifisert Stripe-
   * webhook kan gi hvem som helst Business-planen med én POST.
   */
  STRIPE_WEBHOOK_SECRET: optionalEnv,

  /**
   * Price-ID-ene (`price_…`) fra Stripe, én per betalt plan. Mangler en av dem,
   * kan den planen ikke kjøpes – checkout svarer 503 i stedet for å sende
   * kunden til en tom kasse.
   *
   * ⚠️ **Én price-ID per plan, ikke én per valuta.** Prisene er multi-valuta
   * (`currency_options` i Stripe), og checkout sender `currency` på sesjonen.
   * Et eget sett variabler per marked ville doblet konfigurasjonen for hver
   * valuta vi la til, og gjort det mulig å peke NOK- og EUR-prisen på hvert sitt
   * produkt – og da ville `planForSubscription()` sett to ulike planer.
   *
   * Merk at det er *price*-ID-en, ikke product-ID-en. Bytter du pris senere,
   * peker denne på den nye – eksisterende abonnenter beholder sin gamle pris,
   * og `planForSubscription()` i `lib/stripe.ts` slår derfor også opp via metadata.
   */
  STRIPE_PRICE_PRO: optionalEnv,
  STRIPE_PRICE_BUSINESS: optionalEnv,

  /**
   * Markedet som brukes når hverken abonnement, visningsspråk eller GeoIP sier
   * noe. Se `services/markets.ts`.
   */
  SNOAT_DEFAULT_MARKET: z.enum(["no", "eu"]).default("no"),

  /**
   * Lar Stripe Tax regne ut norsk mva i kassen.
   *
   * ⚠️ Prisene i Stripe er opprettet med `tax_behavior: "exclusive"`, altså
   * **eks. mva** – samme grunnlag som `PLAN_PRICES` i `services/markets.ts`.
   * Står denne på `false`, selger vi derfor Pro til 199 kr uten å kreve inn de
   * 25 prosentene i det hele tatt. Den skal stå på `true` i produksjon.
   *
   * At Stripe Tax er *aktivert* på kontoen holder ikke alene: uten en
   * mva-registrering beregner Stripe 0 %, uten å feile. Registreringene legges
   * inn i dashbordet (Tax → Registrations) – de kan ikke opprettes via API-et.
   * Det er de, ikke dette flagget, som faktisk slår på avgiften. Norge trenger
   * én registrering; salg til EU-forbrukere krever i tillegg VAT OSS
   * (ikke-unionsordningen). Se `CONTEXT_FOR_AI/12_billing_and_plans.md`.
   */
  STRIPE_AUTOMATIC_TAX: z
    .preprocess((value) => value === "true" || value === true, z.boolean())
    .default(false),

  /**
   * Hvor mange dager en kunde med feilet betaling beholder planen sin.
   *
   * Stripe prøver kortet på nytt over omtrent to uker (Smart Retries) før
   * abonnementet gir opp. Nådefristen bør dekke hele det vinduet: en kunde som
   * mister produksjonen sin fordi kortet utløp, kommer ikke tilbake. Først når
   * fristen er ute faller kontoen tilbake til gratisgrensene.
   */
  SNOAT_BILLING_GRACE_DAYS: z.coerce.number().int().nonnegative().default(14),

  /**
   * Skal bakgrunnsjobben faktisk stoppe apper som ligger over gratisgrensen
   * etter at nådefristen er ute?
   *
   * Standard er **av**, og det er et bevisst valg. Mekanismen tar ned kjørende
   * kundeapper uten at et menneske trykker på noe, og den skal ikke slås på før
   * dunning-flyten er observert i produksjon. Med `false` kjører sveipet likevel
   * og logger nøyaktig hva det ville gjort («ville suspendert …»), slik at
   * effekten kan verifiseres i loggen før den blir ekte.
   */
  SNOAT_BILLING_SUSPEND_ENABLED: z
    .preprocess((value) => value === "true" || value === true, z.boolean())
    .default(false),

  /**
   * Kontoer som kjører uten plangrenser i det hele tatt.
   *
   * Komma-separert liste av **bruker-ID-er** (`auth.users.id`, samme verdi som
   * `projects.user_id`) og/eller **e-postadresser**. En oppføring med `@` i seg
   * leses som e-post, alt annet som en ID.
   *
   * ⚠️ **Standard er tom, og tom betyr INGEN eierkontoer – aldri alle.**
   * Det er den farligste standardverdien som finnes her: en fritaksliste som
   * tolker «ingenting oppgitt» som «alle er fritatt» ville slått av hele
   * betalingsmuren i det øyeblikket variabelen falt ut av miljøet. Derfor er
   * regelen at et fritak krever et *treff*, og et treff krever en oppføring.
   * `erEierkonto()` i `services/plans.ts` returnerer usant med én gang lista er
   * tom, og `plans.test.ts` beviser det.
   *
   * Grunnen til at dette er en miljøvariabel og ikke en rad i basen eller en
   * konstant i koden: lista skal kunne endres uten en deploy. Den leses ved
   * oppstart, så en endring krever en omstart av backend – ikke et nytt bygg.
   *
   * ID-formen er den anbefalte. Den slås opp uten et eneste nettverkskall;
   * e-postformen må hente brukeren fra Supabase Auth
   * (`auth.admin.getUserById`, samme vei som `services/notify.ts` bruker) og
   * ligger dermed i deploy-stien.
   */
  SNOAT_OWNER_ACCOUNTS: optionalEnv,

  /**
   * Resend – utgående e-post.
   *
   * Valgfri. Uten nøkkelen sender vi ingenting, og varslene blir en linje i
   * loggen i stedet. Det er med vilje: en plattform som ikke kan deploye fordi
   * en e-postleverandør er nede, er en dårligere plattform enn en som deployer
   * i stillhet.
   */
  RESEND_API_KEY: optionalEnv,

  /**
   * Avsender på varsler. Domenet må være verifisert i Resend, ellers avvises
   * sendingen med 403 – det er ikke noe vi kan sjekke herfra.
   */
  SNOAT_NOTIFY_FROM: z.string().min(1).default("Snoat <varsel@snoat.com>"),

  /**
   * Hvem interne varsler går til. Komma-separert, så drift kan være flere.
   *
   * Er den tom, er varslene av selv om `RESEND_API_KEY` er satt. En liste vi
   * ikke har fått oppgitt skal ikke gjettes.
   */
  SNOAT_NOTIFY_TO: optionalEnv,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Ugyldig miljøkonfigurasjon:\n${issues}`);
}

export const config = parsed.data;
export type Config = typeof config;
