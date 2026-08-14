import { Hono } from "hono";
import { parentDomain, slugFromHostname } from "../lib/caddy.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";

/**
 * Caddys tillatelsessjekk for on-demand TLS.
 *
 * Applikasjonsrutene legges inne i `subroute`-en `snoat_apps` (se `lib/caddy.ts`),
 * og Caddys automatiske HTTPS leter kun etter `host`-matchere blant serverens
 * **toppnivåruter**. Den stiger ikke ned i subroutes. Kundedomenene ble derfor
 * aldri med i settet av administrerte domener, og `<slug>.snoat.com` svarte bare
 * på port 80 – handshaken på 443 ble avbrutt fordi Caddy ikke hadde noe
 * sertifikat å presentere.
 *
 * On-demand løser det: Caddy henter sertifikatet under første TLS-handshake for
 * et navn den ikke kjenner. Men uten en sperre kan hvem som helst peke DNS mot
 * oss og få oss til å be om sertifikater vi ikke skal ha – og Let's Encrypt
 * teller 50 per registrert domene per uke. Caddy spør derfor her først, og
 * utsteder kun når vi svarer 2xx.
 *
 * **Ruten er offentlig lesbar**, siden `api.snoat.com` sender alt som ikke er
 * Supabase videre til backend. Det er greit: svaret røper bare om et domene er
 * deployet på Snoat, og det ser man like godt ved å åpne det over HTTP.
 *
 * Alt som ikke er et sikkert ja er et nei. En databasefeil gir 503, ikke 200 –
 * da uteblir sertifikatet, mens de som allerede er utstedt fortsetter å virke.
 * Motsatt vei ville en feil latt hvem som helst bruke opp kvoten vår.
 */
export const tlsPermission = new Hono();

tlsPermission.get("/tls-ask", async (c) => {
  // Caddy sender navnet fra SNI som `?domain=`.
  const domain = (c.req.query("domain") ?? "").trim().toLowerCase();

  if (domain === "") {
    return c.text("mangler domain", 400);
  }

  const slug = slugFromHostname(domain);

  const lookup = async (column: "name" | "custom_domain", value: string) =>
    await supabase.from("projects").select("id").eq(column, value).maybeSingle();

  let { data, error } = slug
    ? await lookup("name", slug)
    : await lookup("custom_domain", domain);

  // Et eget domene dekker subdomenene sine, siden en flerleietaker-app gir hver
  // kunde sitt eget `<kunde>.domenet` og de ikke kan registreres én for én.
  // Oppslaget gjøres kun når navnet ikke traff et prosjekt direkte, slik at et
  // eksplisitt registrert subdomene alltid vinner over foreldredomenet.
  //
  // Merk at on-demand utsteder ett sertifikat per navn, ikke ett wildcard:
  // Let's Encrypt teller 50 per registrert domene per uke, så en app som får
  // mange nye subdomener på kort tid kan møte den grensen.
  if (!slug && !error && !data) {
    const parent = parentDomain(domain);
    if (parent) {
      ({ data, error } = await lookup("custom_domain", parent));
    }
  }

  if (error) {
    // Fail closed. Caddy prøver igjen ved neste handshake.
    logger.error({ domain, slug, err: error }, "TLS-oppslag feilet");
    return c.text("oppslag feilet", 503);
  }

  if (!data) {
    logger.info({ domain, slug }, "TLS avvist: ingen prosjekt med denne slugen");
    return c.text("ukjent domene", 404);
  }

  logger.info({ domain, slug }, "TLS innvilget");
  return c.text("ok", 200);
});
