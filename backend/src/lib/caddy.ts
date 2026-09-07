import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Klient mot Caddy sitt admin-API.
 *
 * Dokploy bruker Traefik med en fil-provider, der ruter skrives som YAML på
 * disk. Vi bruker i stedet Caddy sitt REST-API (02_architecture.md), som lar
 * oss legge til og fjerne ruter uten å skrive filer eller reloade proxyen.
 *
 * caddy/config.json definerer en tom `subroute` med `@id: "snoat_apps"`. Alle
 * applikasjonsruter legges inn der, hver med sin egen `@id`, slik at de kan
 * adresseres direkte via `/id/<id>` i stedet for array-indekser som flytter seg.
 */

const APPS_ROUTES_PATH = "/id/snoat_apps/handle/0/routes";

const routeId = (slug: string) => `snoat_app_${slug}`;

export const appHostname = (slug: string) => `${slug}${config.SNOAT_APP_DOMAIN_SUFFIX}`;

/**
 * Full URL til appen. `http` lokalt, `https` i produksjon – slik Caddy kjører.
 *
 * Speiler `projectUrl()` i frontend (`lib/platform.ts`) med vilje: de to må gi
 * samme svar, ellers viser dashboardet én lenke og `deployments.url` en annen.
 *
 * Skjemaet avledes av vertsnavnet framfor å være enda en miljøvariabel. En
 * variabel til er en variabel som kan settes feil, og da peker lenkene brukeren
 * får et sted som ikke svarer. `.localhost` betjenes av Caddys interne CA, der
 * sertifikatet ikke er tillitt lokalt – der er `http` det riktige svaret.
 */
export function appUrl(slug: string): string {
  return hostnameUrl(appHostname(slug));
}

/** Samme regel som `appUrl`, men for et vertsnavn vi allerede har. */
export function hostnameUrl(hostname: string): string {
  const isLocal = hostname === "localhost" || hostname.endsWith(".localhost");
  return `${isLocal ? "http" : "https"}://${hostname}`;
}

/**
 * Grenen som én DNS-etikett. Samme slugifisering som `devSiteName()` bruker på
 * prosjektnavnet, slik at `dev.eierfullstack` og `eierfullstack-dev` alltid er
 * det samme stedet – ellers ville de to adressene kunnet peke hver sin vei.
 */
export function branchLabel(branch: string): string | null {
  const label = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return label === "" || label.length > 63 ? null : label;
}

/**
 * Dev-sidens adresse: `dev.eierfullstack.snoat.com`.
 *
 * Den kommer i TILLEGG til `eierfullstack-dev.snoat.com`, ikke i stedet for.
 * `projects.name` er fortsatt identiteten – containernavn, analytics-hostmapet,
 * plangrensene og tls-ask slår alle opp på den – og å bytte den ut ville vært å
 * flytte alt dette samtidig. Ruten får i stedet begge vertsnavnene i
 * host-matcheren sin, og dashboardet viser den pene.
 *
 * Formen krever at DNS svarer på to etiketter under suffikset. `*.snoat.com`
 * gjør det: en wildcard dekker alle navn under seg som ikke har en nærmere node
 * i sonen (RFC 4592), ikke bare én etikett. Verifisert 6. sep 2026 mot 1.1.1.1
 * og 8.8.8.8 – `zz.qq.snoat.com` svarer med serverens IP.
 */
export function devAliasHostname(parentName: string, branch: string): string | null {
  const label = branchLabel(branch);
  if (!label) return null;

  // En dev-side på samme gren som produksjonen finnes ikke, men skulle navnet
  // kollidere med hovedprosjektets eget vertsnavn er det hovedprosjektet som
  // eier adressen.
  if (`${label}.${parentName}` === parentName) return null;

  return `${label}.${appHostname(parentName)}`;
}

/**
 * Motsatt vei: `dev.eierfullstack.snoat.com` → `{ parentName, branchLabel }`.
 *
 * Brukes av tls-ask, som ellers ville nektet sertifikat for dev-adressen –
 * `slugFromHostname()` avviser med vilje alt som har punktum i seg.
 */
export function devAliasParts(
  hostname: string,
): { parentName: string; branchLabel: string } | null {
  const suffix = config.SNOAT_APP_DOMAIN_SUFFIX;
  if (!hostname.endsWith(suffix)) return null;

  const labels = hostname.slice(0, -suffix.length).split(".");
  if (labels.length !== 2) return null;

  const [branch, parent] = labels;
  const valid = (value: string | undefined) => typeof value === "string" && /^[a-z0-9-]+$/.test(value);

  return valid(branch) && valid(parent)
    ? { parentName: parent as string, branchLabel: branch as string }
    : null;
}

/**
 * Motsatt vei av `appHostname`: hvilket prosjekt et domene tilhører.
 *
 * Brukes av TLS-tillatelsessjekken (`routes/tls.ts`) til å avgjøre om Caddy skal
 * hente sertifikat for et navn. Returnerer `null` for alt som ikke er formet som
 * nøyaktig ett Snoat-appdomene, slik at kallet aldri kan slå opp på noe annet
 * enn en prosjekt-slug.
 */
export function slugFromHostname(hostname: string): string | null {
  const suffix = config.SNOAT_APP_DOMAIN_SUFFIX;

  if (!hostname.endsWith(suffix)) return null;

  const slug = hostname.slice(0, -suffix.length);

  // Én etikett, samme form som `projects.name`. Et navn med punktum i seg er et
  // dypere subdomene vi ikke ruter, og skal ikke gi sertifikat.
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

/**
 * Foreldredomenet til et vertsnavn – `a.example.com` gir `example.com`.
 *
 * Et eget domene dekker også subdomenene sine: en flerleietaker-app gir hver
 * kunde sitt eget `<kunde>.domenet`, og de kan ikke registreres én for én.
 * `null` når navnet ikke har et foreldredomene å snakke om (`example.com` selv,
 * eller en enkelt etikett), slik at oppslaget aldri kan treffe et toppdomene.
 */
export function parentDomain(hostname: string): string | null {
  const labels = hostname.split(".");

  // Under tre etiketter finnes det ikke noe foreldredomene som er et registrert
  // domene: `example.com` → `com`, og det skal aldri slås opp.
  if (labels.length < 3) return null;

  const parent = labels.slice(1).join(".");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(parent) ? parent : null;
}

/**
 * `handle` er bevisst løst typet: en rute peker enten på en container
 * (`reverse_proxy`) eller på en katalog med statiske filer (`file_server`), og
 * de to har ikke felles form. Vi leser aldri ut av den uten å sjekke hva vi
 * faktisk fikk – se `routeUpstream()` og `routeRoot()`.
 */
export interface CaddyRoute {
  "@id": string;
  match: Array<{ host: string[] }>;
  handle: Array<Record<string, unknown>>;
  terminal: boolean;
}

class CaddyError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`Caddy ${method} ${path} feilet (${status}): ${body}`);
    this.name = "CaddyError";
  }
}

/**
 * Caddy krever at admin-kall kommer fra en kjent origin når admin-API-et lytter
 * på noe annet enn loopback (det gjør det her, siden backend står i en egen
 * container). Vi setter headeren eksplisitt i stedet for å stole på hva
 * runtime-en finner på: `fetch` uten Origin avvises med
 * «client is not allowed to access from origin ''», mens curl slipper gjennom.
 * Verdien må matche `admin.origins` i caddy/config.json.
 */
const adminOrigin = new URL(config.CADDY_ADMIN_URL).origin;

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${config.CADDY_ADMIN_URL}${path}`, {
    method,
    headers: {
      Origin: adminOrigin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw new CaddyError(response.status, method, path, await response.text());
  }

  return response;
}

/**
 * Caddy svarer 500 med "unknown object ID" når en `@id` ikke finnes. For oss er
 * det «ruten er ikke opprettet ennå», ikke en feil.
 */
function isUnknownObject(error: unknown): boolean {
  return error instanceof CaddyError && /unknown object ID/i.test(error.message);
}

/** Sjekker at admin-API-et svarer. Brukes av /health. */
export async function ping(): Promise<void> {
  await request("GET", "/config/apps/http/servers/snoat/listen");
}

/**
 * Peker `<slug>.snoat.localhost` mot en container.
 *
 * `upstream` er `containernavn:port`. Caddy og containeren må ligge på samme
 * Docker-nettverk (SNOAT_APPS_NETWORK) for at navneoppslaget skal fungere.
 *
 * PATCH mot `/id/<rute>` bytter ruten **atomisk** i Caddys minne: forespørsler
 * som er underveis fullføres mot den gamle upstreamen, og neste forespørsel
 * treffer den nye. Det er dette som gjør utrullingen uten nedetid mulig –
 * DELETE etterfulgt av POST ville hatt et vindu der subdomenet ikke matchet
 * noen rute i det hele tatt, og brukerne ville fått 404.
 */
export async function upsertAppRoute(
  slug: string,
  customDomain: string | null,
  upstream: string,
  accessPasswordHash: string | null = null,
  aliasHosts: string[] = [],
): Promise<string> {
  return await upsertRoute(
    slug,
    hostsFor(slug, customDomain, aliasHosts),
    injectHandlers([{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }]),
    { upstream, protected: Boolean(accessPasswordHash) },
    accessPasswordHash,
  );
}

/**
 * Peker `<slug>.snoat.localhost` mot en katalog med ferdigbygde filer.
 *
 * En statisk side trenger ingen kjørende prosess. Caddy leser filene rett fra
 * det delte volumet, så en side som ikke besøkes koster null RAM og null CPU –
 * i motsetning til en container, som koster like mye uansett om noen er der.
 *
 * `spaFallback` styrer hva som skjer med en URL som ikke finnes som fil.
 * Uten: 404, som er riktig for Astro, Hugo og Eleventy, der `404.html` er en
 * ekte side. Med: `index.html` serveres i stedet, som er det en SPA med
 * klientruting (React Router, TanStack Router) trenger for at dype lenker skal
 * virke ved direkte innlasting. Begge formene er verifisert mot Caddy 2.11.4.
 */
export async function upsertStaticRoute(
  slug: string,
  customDomain: string | null,
  root: string,
  spaFallback: boolean,
  accessPasswordHash: string | null = null,
  aliasHosts: string[] = [],
): Promise<string> {
  return await upsertRoute(
    slug,
    hostsFor(slug, customDomain, aliasHosts),
    injectHandlers(staticHandlers(root, spaFallback)),
    { root, spaFallback, protected: Boolean(accessPasswordHash) },
    accessPasswordHash,
  );
}

/**
 * Vertsnavnene ruten skal svare på, i den rekkefølgen de skal stå.
 *
 * Et eget domene tar med subdomenene sine. Caddys host-matcher støtter `*` som
 * én etikett helt foran, så `*.example.com` treffer `a.example.com`, men ikke
 * `example.com` selv – derfor må begge stå oppført.
 */
function hostsFor(slug: string, customDomain: string | null, aliasHosts: string[] = []): string[] {
  const hosts = [appHostname(slug), ...aliasHosts];
  if (customDomain) hosts.push(customDomain, `*.${customDomain}`);
  return [...new Set(hosts)];
}

function staticHandlers(root: string, spaFallback: boolean): Array<Record<string, unknown>> {
  if (!spaFallback) {
    return [
      { handler: "vars", root },
      { handler: "file_server", index_names: ["index.html"] },
    ];
  }

  // Tilsvarer `try_files {path} {path}/index.html /index.html` i en Caddyfile:
  // treffer forespørselen en fil, serveres den; ellers skrives URL-en om til
  // index.html og klientruteren tar over.
  return [
    {
      handler: "subroute",
      routes: [
        { handle: [{ handler: "vars", root }] },
        {
          match: [
            {
              file: {
                try_files: [
                  "{http.request.uri.path}",
                  "{http.request.uri.path}/index.html",
                  "/index.html",
                ],
              },
            },
          ],
          handle: [{ handler: "rewrite", uri: "{http.matchers.file.relative}" }],
        },
        { handle: [{ handler: "file_server" }] },
      ],
    },
  ];
}

/**
 * Stien collectoren serveres fra, og rapporterer inn til.
 *
 * Dobbel understrek fordi det ikke kolliderer med noe rammeverk vi hoster:
 * Next eier `/_next`, Astro `/_astro`, Vite `/@vite`. Ruten som sender disse to
 * til backend ligger i caddy/config.json, foran app-rutene, slik at hver eneste
 * vert svarer på dem uten at app-ruten trenger å vite noe om det.
 */
export const ERROR_COLLECTOR_PATH = "/__snoat/err.js";

/** Script-tagen som injiseres. `defer` slik at den aldri blokkerer opptegningen. */
const COLLECTOR_TAG = `<script src="${ERROR_COLLECTOR_PATH}" defer></script>`;

/**
 * Handlerne som limer collectoren inn i HTML-svarene til en app.
 *
 * ## Hvorfor i proxyen og ikke i appen
 *
 * Analytikken slipper unna uten å røre svarene i det hele tatt – den leser
 * Caddys access-logg. Klientfeil finnes ikke i den loggen: en `TypeError` i
 * nettleseren gir ingen forespørsel, ingen statuskode, ingenting proxyen kan se.
 * Noe må kjøre i nettleseren, og da er spørsmålet bare hvem som setter det inn.
 *
 * Kundens kildekode er feil svar. Da må det legges til per app, holdes
 * oppdatert per app, og det kan brekke et bygg. Her settes det inn på vei ut av
 * proxyen: alle apper får det, gamle deployments får det uten å bygges på nytt,
 * og det finnes ingen versjon å holde synkronisert.
 *
 * ## Hvorfor formen er så omstendelig
 *
 * Tre ting måtte løses samtidig:
 *
 * 1. **Kun HTML.** Matcheren på `Accept: *text/html*` gjør at et bilde, et
 *    API-svar eller en JS-bundle aldri går innom erstatteren. Det er en
 *    forespørselsmatcher og ikke en svarmatcher – Caddy har ikke det siste – men
 *    den treffer riktig i praksis: nettleseren ber om `text/html` på navigasjon
 *    og aldri på en subressurs.
 *
 * 2. **Ukomprimert oppstrøms.** Next komprimerer selv som standard. Kommer
 *    HTML-en gzippet ut av containeren, finnes det ingen `</head>` å treffe, og
 *    injeksjonen ville stille gjort ingenting. `Accept-Encoding: identity` mot
 *    oppstrøms slår det av – men kun for navigasjonsforespørsler, som er en
 *    håndfull kilobyte. Bildene og bundlene komprimeres som før.
 *
 * 3. **Ingen bufring.** `stream: true` gjør erstatningen underveis i stedet for
 *    å samle hele svaret i minnet først. En app som streamer et stort svar med
 *    `Accept: text/html` skal ikke kunne spise minnet til proxyen.
 *
 * Erstatningen er en ren streng og ikke et regulært uttrykk, med vilje:
 * strømmemodus krever det, og en regex mot vilkårlig kunde-HTML er en
 * katastrofe som venter på å skje.
 *
 * `</head>` og ikke `<head>`: en app kan ha `<base>`- og CSP-taggene sine først,
 * og collectoren skal ikke kunne komme foran dem. Har svaret ingen `</head>` –
 * et fragment, en HTML-snutt fra en HTMX-endepunkt – skjer det ingenting, og det
 * er riktig utfall.
 */
function injectHandlers(handle: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [
    {
      handler: "subroute",
      routes: [
        {
          match: [{ header: { Accept: ["*text/html*"] } }],
          handle: [
            {
              handler: "headers",
              request: { set: { "Accept-Encoding": ["identity"] } },
            },
            {
              handler: "replace_response",
              stream: true,
              replacements: [
                { search: "</head>", replace: `${COLLECTOR_TAG}</head>` },
              ],
            },
          ],
        },
        { handle },
      ],
    },
  ];
}

/**
 * Brukernavnet på en passordbeskyttet app.
 *
 * Basic auth krever et brukernavn, men det finnes ingen brukere her – det er
 * *appen* som er beskyttet, ikke en konto. Ett fast navn er da mer ærlig enn å
 * late som det betyr noe, og det er én ting mindre å formidle til den som skal
 * inn. Nettleseren husker paret uansett.
 */
export const ACCESS_USERNAME = "snoat";

/**
 * Caddy-handleren som krever passord før forespørselen slipper videre.
 *
 * `http_basic` sammenligner mot en bcrypt-hash Caddy selv verifiserer. Passordet
 * forlater derfor aldri Caddy, og backend er ikke i veien for en enkelt
 * forespørsel til appen – hadde vi brukt `forward_auth`, ville hver visning av
 * dev-siden vært avhengig av at backend svarer.
 *
 * `hash_cache` er ikke pynt: bcrypt med cost 12 er ~250 ms med vilje, og uten
 * cachen betaler hver enkelt forespørsel – også hvert bilde og hver JS-fil på
 * siden – den prisen på nytt.
 */
function basicAuthHandler(hash: string): Record<string, unknown> {
  return {
    handler: "authentication",
    providers: {
      http_basic: {
        hash: { algorithm: "bcrypt" },
        hash_cache: {},
        accounts: [{ username: ACCESS_USERNAME, password: hash }],
      },
    },
  };
}

async function upsertRoute(
  slug: string,
  hosts: string[],
  handle: Array<Record<string, unknown>>,
  logContext: Record<string, unknown>,
  accessPasswordHash: string | null = null,
): Promise<string> {
  const hostname = hosts[0] ?? appHostname(slug);

  // Vakten står *først*: en 401 skal komme før reverse_proxy har åpnet en
  // forbindelse til appen, og før file_server har lest en fil fra disk.
  const handlers = accessPasswordHash
    ? [basicAuthHandler(accessPasswordHash), ...handle]
    : handle;

  const route: CaddyRoute = {
    "@id": routeId(slug),
    match: [{ host: hosts }],
    handle: handlers,
    terminal: true,
  };

  try {
    await request("PATCH", `/id/${routeId(slug)}`, route);
    logger.info({ slug, hostname, ...logContext }, "Caddy-rute byttet");
    return appUrl(slug);
  } catch (error) {
    // Første deployment: ruten finnes ikke ennå, så det er ingenting å bytte.
    if (!isUnknownObject(error)) throw error;
  }

  await request("POST", APPS_ROUTES_PATH, route);

  logger.info({ slug, hostname, ...logContext }, "Caddy-rute opprettet");
  return appUrl(slug);
}

/**
 * Upstreamen ruten faktisk peker på nå, lest tilbake fra Caddy.
 *
 * Brukes til to ting: å bekrefte at byttet gikk gjennom før vi fjerner den
 * gamle containeren, og å huske hva som serverte trafikk før en deployment, slik
 * at vi kan peke tilbake dit hvis den feiler.
 */
export async function appRouteUpstream(slug: string): Promise<string | null> {
  return routeUpstream(await getAppRoute(slug));
}

/** Katalogen en statisk rute serverer nå. `null` for en container-rute. */
export async function appRouteRoot(slug: string): Promise<string | null> {
  return routeRoot(await getAppRoute(slug));
}

/**
 * Hele ruten slik Caddy har den, eller `null` hvis den ikke finnes.
 *
 * Deploymenten leser denne før den rører noe, slik at en feilet utrulling kan
 * settes nøyaktig tilbake – uten å vite om det som sto der var en container
 * eller en katalog.
 */
export async function getAppRoute(slug: string): Promise<CaddyRoute | null> {
  try {
    const response = await request("GET", `/id/${routeId(slug)}`);
    return ((await response.json()) as CaddyRoute | null) ?? null;
  } catch (error) {
    if (isUnknownObject(error)) return null;
    throw error;
  }
}

/** Setter en tidligere lest rute tilbake. Brukes ved rollback eller endring av domene. */
export async function restoreAppRoute(slug: string, customDomain: string | null, route: CaddyRoute): Promise<void> {
  // Vertsnavnene tas fra ruten slik den sto, ikke bygges opp på nytt: en
  // dev-side svarer også på `dev.<prosjekt>`-adressen sin, og en rollback som
  // utledet hostene av slug og eget domene ville stille fjernet den.
  //
  // Handler-kjeden settes tilbake som den var – vakten står allerede først i
  // den, så hashen skal ikke legges på en gang til.
  await upsertRoute(
    slug,
    route.match?.[0]?.host ?? hostsFor(slug, customDomain),
    route.handle,
    { restored: true },
  );
}

/**
 * Alle handlerne i en rute, også de som ligger inne i en `subroute`.
 *
 * ⚠️ Leserne under så tidligere bare på `handle[0]`, og det var feil så snart
 * appen var passordbeskyttet: `upsertRoute()` setter basic-auth-vakten *først*,
 * så `handle[0]` er `authentication` og ikke `reverse_proxy`. Begge leserne
 * svarte da `null` på en rute som var helt i orden, og
 * `runPipeline()` konkluderte med «Caddy peker på ingenting etter byttet» og
 * rullet tilbake en container som kjørte. Siden hver dev-side er beskyttet fra
 * fødselen av, feilet *hver eneste* dev-deployment på siste steg.
 */
function* allHandlers(
  handlers: Array<Record<string, unknown>> | undefined,
): Generator<Record<string, unknown>> {
  for (const handler of handlers ?? []) {
    yield handler;

    const routes = handler.routes;
    if (!Array.isArray(routes)) continue;

    for (const sub of routes as Array<{ handle?: Array<Record<string, unknown>> }>) {
      yield* allHandlers(sub.handle);
    }
  }
}

export function routeUpstream(route: CaddyRoute | null): string | null {
  for (const handler of allHandlers(route?.handle)) {
    if (handler.handler !== "reverse_proxy") continue;

    const upstreams = handler.upstreams;
    if (!Array.isArray(upstreams)) continue;

    const dial = (upstreams[0] as { dial?: unknown } | undefined)?.dial;
    if (typeof dial === "string") return dial;
  }

  return null;
}

/** Sant når ruten krever passord. Leses tilbake fra Caddy, ikke fra databasen. */
export function routeIsProtected(route: CaddyRoute | null): boolean {
  for (const handler of allHandlers(route?.handle)) {
    if (handler.handler === "authentication") return true;
  }

  return false;
}

/**
 * Katalogen en statisk rute peker på.
 *
 * `root` ligger på ulikt sted i de to formene `staticHandlers()` lager: rett på
 * et handler-objekt uten SPA-fallback, og inne i subrouten med. Derfor leter vi
 * gjennom hele kjeden framfor å vite hvor den skal stå.
 */
export function routeRoot(route: CaddyRoute | null): string | null {
  for (const handler of allHandlers(route?.handle)) {
    if (typeof handler.root === "string") return handler.root;
  }

  return null;
}

/** Fjerner ruten for et prosjekt. Er en no-op hvis den ikke finnes. */
export async function removeAppRoute(slug: string): Promise<void> {
  try {
    await request("DELETE", `/id/${routeId(slug)}`);
    logger.info({ slug }, "Caddy-rute fjernet");
  } catch (error) {
    if (isUnknownObject(error)) return;
    throw error;
  }
}

/** Slugene Caddy for øyeblikket har ruter for. Brukes til reconcile mot Supabase. */
export async function listAppSlugs(): Promise<string[]> {
  const response = await request("GET", APPS_ROUTES_PATH);
  const routes = (await response.json()) as Array<{ "@id"?: string }> | null;

  return (routes ?? [])
    .map((route) => route["@id"])
    .filter((id): id is string => typeof id === "string" && id.startsWith("snoat_app_"))
    .map((id) => id.slice("snoat_app_".length));
}
