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

  /** Origin dashboardet kjører på – eneste tillatte CORS-origin. */
  SNOAT_FRONTEND_ORIGIN: z.string().default("http://localhost:8080"),

  /**
   * Porten brukerapplikasjoner forventes å lytte på inne i containeren.
   * Injiseres som `PORT`, etter samme konvensjon som Heroku og Railway.
   */
  SNOAT_APP_PORT: z.coerce.number().int().positive().default(3000),

  /**
   * Ressurstak per applikasjonscontainer. Dette er mekanismen som gjør
   * gratisplanen mulig uten at ett prosjekt kan spise opp verten
   * (01_vision_and_brand.md).
   */
  SNOAT_APP_MEMORY_MB: z.coerce.number().int().positive().default(512),
  SNOAT_APP_CPUS: z.coerce.number().positive().default(1),

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
   * Settes for lavt feiler store prosjekter unødvendig. Tommelfingerregel: rundt
   * 75 % av minnet verten kan avse til én build.
   */
  SNOAT_BUILD_NODE_MEMORY_MB: z.coerce.number().int().positive().default(1536),

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
