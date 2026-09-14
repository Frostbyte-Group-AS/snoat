import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * Adgangscookien: signert bevis på at noen har tastet riktig passord for én
 * app på ett vertsnavn.
 *
 * Erstatter Caddys `http_basic`-vakt (se `guardedHandlers()` i `lib/caddy.ts`).
 * bcrypt kjører nå bare ved innlogging (`POST /_snoat/adgang` i
 * `routes/access-gate.ts`). Sjekken foran hver forespørsel er en ren
 * HMAC-verifisering: ingen bcrypt, ingen databasespørring.
 *
 * ## Hva signaturen binder
 *
 * - **Prosjekt-ID og vertsnavn.** En cookie fra ett vertsnavn virker ikke på et
 *   annet, heller ikke et annet vertsnavn for samme prosjekt. Nettleseren
 *   sender den uansett bare til vertsnavnet den ble satt på (ingen `Domain`),
 *   så dette er et andre lag.
 * - **Passordversjonen** (`accessVersion()`): et nytt passord gir en ny
 *   versjon i Caddy-ruten, og alle cookies utstedt for det gamle slutter å
 *   virke med en gang.
 * - **Utløpet**, 24 timer.
 *
 * Tokenet er `<utløp>.<signatur>`. Prosjekt-ID-en står ikke i klartekst; den
 * kommer fra Caddy-ruten.
 *
 * ## Hemmeligheten
 *
 * Utledet fra `SUPABASE_SERVICE_ROLE_KEY` med domeneseparasjon, samme mønster
 * som `consentSecret()` i `lib/oauth.ts`: ingen ny miljøvariabel som kan
 * mangle i produksjon.
 */

export const ACCESS_COOKIE_NAME = "snoat_adgang";

/**
 * Navnet cookien faktisk settes og leses med.
 *
 * I produksjon med `__Host-`-prefikset: nettleseren godtar den da bare med
 * `Secure`, `Path=/` og uten `Domain`, så en annen kundes app på
 * `<noe>.snoat.com` kan ikke plante en med samme navn for hele `snoat.com`.
 * Lokalt (HTTP på `.snoat.localhost`) går ikke prefikset, siden det krever
 * `Secure`.
 */
export function accessCookieName(local: boolean): string {
  return local ? ACCESS_COOKIE_NAME : `__Host-${ACCESS_COOKIE_NAME}`;
}

const ACCESS_COOKIE_TTL_SECONDS = 60 * 60 * 24;

export function accessCookieTtlSeconds(): number {
  return ACCESS_COOKIE_TTL_SECONDS;
}

function accessCookieSecret(): Buffer {
  return createHmac("sha256", config.SUPABASE_SERVICE_ROLE_KEY)
    .update("snoat-adgang-cookie-v2")
    .digest();
}

/**
 * Versjonen av passordet, slik den står i Caddy-ruten.
 *
 * Et fingeravtrykk av bcrypt-hashen, ikke hashen selv: Caddy trenger bare å
 * vite *at* passordet er byttet. Hashen er saltet, så det samme passordet satt
 * på nytt gir også en ny versjon.
 *
 * `null` (beskyttet, men ingen hash å lese) gir en fast versjon som ingen
 * innlogging kan matche, siden det ikke finnes noe passord å taste: vakten
 * feiler lukket.
 */
export function accessVersion(hash: string | null): string {
  if (!hash) return "uten-passord";
  return createHash("sha256").update(`snoat-adgang-versjon-v1\n${hash}`).digest("hex").slice(0, 32);
}

function sign(projectId: string, hostname: string, version: string, expiresAt: number): string {
  return createHmac("sha256", accessCookieSecret())
    .update(`${projectId}\n${hostname}\n${version}\n${expiresAt}`)
    .digest("base64url");
}

/** Nytt, signert token for et prosjekt på ett vertsnavn og én passordversjon. */
export function issueAccessToken(
  projectId: string,
  hostname: string,
  version: string,
  now: number = Date.now(),
): string {
  const expiresAt = Math.floor(now / 1000) + ACCESS_COOKIE_TTL_SECONDS;
  return `${expiresAt}.${sign(projectId, hostname, version, expiresAt)}`;
}

/**
 * Sant når tokenet er utstedt for nettopp dette prosjektet, vertsnavnet og
 * passordet, og ikke er utløpt. Signaturen sammenlignes med `timingSafeEqual`.
 */
export function verifyAccessToken(
  token: string,
  projectId: string,
  hostname: string,
  version: string,
  now: number = Date.now(),
): boolean {
  if (!projectId || !hostname || !version) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [expiresAtRaw, signature] = parts as [string, string];
  if (!/^\d{1,12}$/.test(expiresAtRaw)) return false;

  const expiresAt = Number(expiresAtRaw);
  const nowSeconds = Math.floor(now / 1000);
  if (expiresAt < nowSeconds) return false;
  // Et utløp lenger fram enn en cookie noen gang får, er ikke utstedt av oss.
  if (expiresAt > nowSeconds + ACCESS_COOKIE_TTL_SECONDS + 60) return false;

  const expected = Buffer.from(sign(projectId, hostname, version, expiresAt));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
