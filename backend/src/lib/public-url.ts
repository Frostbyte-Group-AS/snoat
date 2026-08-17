import type { Context } from "hono";
import { config } from "../config.js";

/**
 * Den offentlige URL-en backend faktisk ble nådd på.
 *
 * OAuth-metadataen må oppgi absolutte URL-er til seg selv: `issuer`,
 * `authorization_endpoint`, `token_endpoint` og ressurs-identifikatoren for
 * MCP-endepunktet. Claude sammenligner `issuer` med URL-en den hentet
 * metadataen fra, så en verdi som er *nesten* riktig gir en connector som
 * feiler i oppkoblingen med en melding kunden ikke kan gjøre noe med.
 *
 * Derfor leses den ut av forespørselen i stedet for å konfigureres. En
 * miljøvariabel her ville vært en variabel som må huskes i produksjon, og den
 * feilen har vi sett før: arver man `.env` fra et lokalt oppsett, står det
 * `http://api.snoat.localhost` i produksjon – og da peker metadataen kundens
 * Claude på en URL som bare finnes på utviklingsmaskinen.
 *
 * Caddy videresender `Host` urørt og setter `X-Forwarded-Proto`, så headerne er
 * fasiten om hvordan verden nådde oss.
 */
export function publicApiUrl(c: Context): string {
  if (config.SNOAT_PUBLIC_API_URL) {
    return config.SNOAT_PUBLIC_API_URL.replace(/\/+$/, "");
  }

  const host = c.req.header("X-Forwarded-Host") ?? c.req.header("Host");

  if (!host) {
    // Ingen Host-header i det hele tatt er teoretisk mulig i HTTP/1.0. Da er
    // URL-en i forespørselen det eneste vi har.
    return new URL(c.req.url).origin;
  }

  // `.localhost` og rene IP-er kan ikke ha et gyldig sertifikat, og et lokalt
  // oppsett kjører uten TLS. Ellers antar vi https: en connector som får en
  // http-URL i metadataen blir avvist av klienten.
  const forwarded = c.req.header("X-Forwarded-Proto")?.split(",")[0]?.trim();
  const proto = forwarded ?? (host.endsWith(".localhost") || host === "localhost" ? "http" : "https");

  return `${proto}://${host}`;
}

/**
 * Ressurs-identifikatoren for MCP-endepunktet (RFC 8707).
 *
 * Dette er både URL-en kunden limer inn i Claude og verdien `resource`-
 * parameteren i OAuth-flyten skal ha. Én funksjon, slik at de to aldri kan
 * komme i utakt.
 */
export function mcpResourceUrl(c: Context): string {
  return `${publicApiUrl(c)}/api/mcp`;
}

/**
 * Dashboardets origin – der samtykkesiden ligger.
 *
 * `SNOAT_FRONTEND_ORIGIN` kan inneholde flere origins (CORS-allowlisten tar en
 * kommaseparert liste). Den første er den kanoniske: det er den kunden faktisk
 * bruker, og de øvrige finnes for at et lokalt oppsett skal kunne nå backend
 * både som `localhost:8080` og `snoat.localhost`.
 */
export function dashboardUrl(): string {
  const first = config.SNOAT_FRONTEND_ORIGIN.split(",")[0]?.trim() ?? "";
  return first.replace(/\/+$/, "");
}
