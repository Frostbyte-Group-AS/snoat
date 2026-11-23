/**
 * Spør appen selv om et subdomene under dens eget domene skal få sertifikat.
 *
 * Et eget domene dekker subdomenene sine (se `routes/tls.ts`), så uten dette
 * fikk hvert eneste `<hva-som-helst>.domenet` sertifikat ved første besøk. Let's
 * Encrypt gir høyst 50 nye per registrert domene per uke. En flerleietaker-app
 * med tusenvis av offentlige subdomener – eller en crawler som prøver tilfeldige
 * navn – bruker da opp kvoten, og ekte kunder står uten HTTPS resten av uka.
 *
 * Prosjektet slår det på med miljøvariabelen `SNOAT_TLS_ASK_PATH`, for eksempel
 * `/api/infra/domain-check`. Snoat kaller da `https://<foreldredomenet><sti>?domain=…`,
 * og bare 2xx gir sertifikat. Uten variabelen er alt som før.
 *
 * Backend står ikke på `snoat_apps`-nettet (og skal ikke: da kunne appene nådd
 * de interne rutene), så kallet går til Caddy på det interne `snoat`-nettet med
 * foreldredomenet som SNI og Host. Det domenet har alt sertifikat, så kallet
 * kan ikke selv utløse et nytt, og sertifikatet sjekkes som vanlig.
 */
import https from "node:https";

export const TLS_ASK_PATH_ENV = "SNOAT_TLS_ASK_PATH";

/** Caddy venter på svaret under en TLS-handshake, så appen får kort tid. */
export const TLS_ASK_TIMEOUT_MS = 3_000;

export type AppTlsAnswer = "ja" | "nei" | "feil";

/**
 * Stien fra prosjektets miljøvariabler, eller `null` når den mangler eller er
 * ugyldig. Bare en absolutt sti uten skjema, vert eller spørrestreng godtas, så
 * variabelen aldri kan sende Snoat til en annen vert.
 */
export function tlsAskPath(envVars: Record<string, string> | null | undefined): string | null {
  const raw = envVars?.[TLS_ASK_PATH_ENV]?.trim();
  if (!raw) return null;
  return /^\/[A-Za-z0-9._~\-/]*$/.test(raw) && !raw.startsWith("//") ? raw : null;
}

/** Caddy på det interne nettet. Kan overstyres for lokal kjøring. */
export const CADDY_INTERNAL_HOST = process.env.SNOAT_CADDY_INTERNAL_HOST || "caddy";

export function tlsAskRequestPath(path: string, domain: string): string {
  return `${path}?domain=${encodeURIComponent(domain)}`;
}

/** Svarer med statuskoden, eller kaster ved nettverksfeil og tidsavbrudd. */
export type StatusRequester = (host: string, requestPath: string, timeoutMs: number) => Promise<number>;

export const httpsViaCaddy: StatusRequester = (host, requestPath, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: CADDY_INTERNAL_HOST,
        port: 443,
        servername: host,
        method: "GET",
        path: requestPath,
        headers: { host },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => req.destroy(new Error("tidsavbrudd")));
    req.on("error", reject);
    req.end();
  });

/**
 * 2xx er ja, 4xx er nei. Alt annet – 5xx, tidsavbrudd, nettverksfeil – er
 * «feil», som `tls.ts` gjør om til 503: Caddy lar være å utstede og prøver
 * igjen ved neste handshake.
 */
export async function askApp(
  parentHost: string,
  path: string,
  domain: string,
  requester: StatusRequester = httpsViaCaddy,
  timeoutMs = TLS_ASK_TIMEOUT_MS,
): Promise<AppTlsAnswer> {
  try {
    const status = await requester(parentHost, tlsAskRequestPath(path, domain), timeoutMs);
    if (status >= 200 && status < 300) return "ja";
    if (status >= 400 && status < 500) return "nei";
    return "feil";
  } catch {
    return "feil";
  }
}
