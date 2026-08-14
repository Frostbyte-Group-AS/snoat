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
  const hostname = appHostname(slug);
  const isLocal = hostname === "localhost" || hostname.endsWith(".localhost");
  return `${isLocal ? "http" : "https"}://${hostname}`;
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
export async function upsertAppRoute(slug: string, customDomain: string | null, upstream: string): Promise<string> {
  return await upsertRoute(
    slug,
    customDomain,
    [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
    { upstream },
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
): Promise<string> {
  return await upsertRoute(slug, customDomain, staticHandlers(root, spaFallback), { root, spaFallback });
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

async function upsertRoute(
  slug: string,
  customDomain: string | null,
  handle: Array<Record<string, unknown>>,
  logContext: Record<string, unknown>,
): Promise<string> {
  const hostname = appHostname(slug);

  // Et eget domene tar med subdomenene sine. Caddys host-matcher støtter `*` som
  // én etikett helt foran, så `*.example.com` treffer `a.example.com`, men ikke
  // `example.com` selv – derfor må begge stå oppført.
  const hosts = customDomain
    ? [hostname, customDomain, `*.${customDomain}`]
    : [hostname];

  const route: CaddyRoute = {
    "@id": routeId(slug),
    match: [{ host: hosts }],
    handle,
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
  await upsertRoute(slug, customDomain, route.handle, { restored: true });
}

export function routeUpstream(route: CaddyRoute | null): string | null {
  const first = route?.handle?.[0];
  if (!first || first.handler !== "reverse_proxy") return null;

  const upstreams = first.upstreams;
  if (!Array.isArray(upstreams)) return null;

  const dial = (upstreams[0] as { dial?: unknown } | undefined)?.dial;
  return typeof dial === "string" ? dial : null;
}

/**
 * Katalogen en statisk rute peker på.
 *
 * `root` ligger på ulikt sted i de to formene `staticHandlers()` lager: rett på
 * det første handler-objektet uten SPA-fallback, og inne i subrouten med.
 */
export function routeRoot(route: CaddyRoute | null): string | null {
  const first = route?.handle?.[0];
  if (!first) return null;

  if (typeof first.root === "string") return first.root;

  if (Array.isArray(first.routes)) {
    for (const sub of first.routes as Array<{ handle?: Array<Record<string, unknown>> }>) {
      const root = sub.handle?.[0]?.root;
      if (typeof root === "string") return root;
    }
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
