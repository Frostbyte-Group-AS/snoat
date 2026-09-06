/**
 * Plattformkonstantene frontend trenger for å vise hvor apper havner, og hvor
 * kundene skal peke sine egne domener.
 *
 * Vite baker `VITE_`-variabler inn i bundlen ved build, ikke ved oppstart – se
 * 09_production_deployment.md. Verdiene her følger derfor `.env` på maskinen
 * som bygde frontend, og fallbackene er produksjonsverdiene for snoat.com.
 */

/** Domenet deployede apper havner under. Følger `SNOAT_APP_DOMAIN_SUFFIX`. */
export const appDomainSuffix =
  (import.meta.env.VITE_SNOAT_APP_DOMAIN_SUFFIX as string | undefined) ?? ".snoat.com";

/**
 * IP-en kundene peker sitt eget domene mot med en A-record. Følger
 * `SNOAT_SERVER_IP` – VPS-en Caddy står på (09_production_deployment.md).
 */
export const snoatServerIp =
  (import.meta.env.VITE_SNOAT_SERVER_IP as string | undefined) ?? "38.87.117.167";

/** `<slug>.snoat.com` – verten Caddy ruter til prosjektets container. */
export const projectHostname = (slug: string) => `${slug}${appDomainSuffix}`;

/** Full URL til prosjektet. `http` lokalt, `https` i produksjon – slik Caddy kjører. */
export function projectUrl(slug: string): string {
  const hostname = projectHostname(slug);
  const isLocal = hostname === "localhost" || hostname.endsWith(".localhost");
  return `${isLocal ? "http" : "https"}://${hostname}`;
}

/**
 * Grenen som én DNS-etikett. Speiler `branchLabel()` i backend
 * (`lib/caddy.ts`) – de to må gi samme svar, ellers viser dashboardet en
 * adresse Caddy ikke ruter.
 */
export function branchLabel(branch: string): string | null {
  const label = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return label === "" || label.length > 63 ? null : label;
}

/**
 * Dev-sidens pene adresse: `dev.eierfullstack.snoat.com`.
 *
 * Dev-siden svarer også på `eierfullstack-dev.snoat.com` – navnet er fortsatt
 * identiteten – men det er denne som vises, fordi den sier hva den er uten at
 * man må kunne navnekonvensjonen. `null` når grenen ikke kan bli en etikett.
 */
export function devSiteHostname(parentName: string, branch: string): string | null {
  const label = branchLabel(branch);
  return label ? `${label}.${projectHostname(parentName)}` : null;
}

/** Full URL til dev-sidens pene adresse, eller `null`. */
export function devSiteUrl(parentName: string, branch: string): string | null {
  const hostname = devSiteHostname(parentName, branch);
  if (!hostname) return null;
  const isLocal = hostname.endsWith(".localhost");
  return `${isLocal ? "http" : "https"}://${hostname}`;
}
