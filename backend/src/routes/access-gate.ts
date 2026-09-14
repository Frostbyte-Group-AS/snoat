import bcrypt from "bcryptjs";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { setCookie } from "hono/cookie";
import {
  accessCookieName,
  accessCookieTtlSeconds,
  issueAccessToken,
  verifyAccessToken,
} from "../lib/access-cookie.js";
import {
  ACCESS_CHECK_PATH,
  ACCESS_GATE_PATH,
  ACCESS_HEADERS,
} from "../lib/caddy.js";
import { logger } from "../lib/logger.js";
import { passwordHashFor } from "../services/dev-sites.js";

/**
 * Passordsiden foran en beskyttet app, og adgangssjekken Caddy spør før den
 * slipper en forespørsel videre til appen.
 *
 * Erstatter Caddys `http_basic`-dialog (nettleserens egen, med et
 * brukernavnfelt ingen trengte). Hele Hono-instansen serveres på den interne
 * porten `SNOAT_ACCESS_CHECK_PORT` (se `index.ts`), og nås bare gjennom ruten
 * `guardedHandlers()` i `lib/caddy.ts` skriver for en beskyttet app:
 *
 * - `ACCESS_CHECK_PATH`: sjekken foran hver forespørsel. `204` slipper
 *   forespørselen videre til appen; alt annet er `401` med passordsiden, som
 *   Caddy sender klienten uendret, på adressen klienten ba om.
 * - `GET`/`POST ACCESS_GATE_PATH`: skjemaet og innloggingen.
 *
 * Prosjektet, passordversjonen, vertsnavnet, den opprinnelige URI-en og
 * klientens IP kommer i headere Caddy-ruten **setter** (`ACCESS_HEADERS`).
 * De kan stoles på fordi porten bare er på `snoat`-nettverket.
 *
 * Ingen `WWW-Authenticate`, noe sted: det er den headeren som får nettleseren
 * til å vise sin egen dialog.
 */

// ---------------------------------------------------------------------------
// Åpen redirect: `retur` må være en sti på samme vert, aldri en URL et annet
// sted.
// ---------------------------------------------------------------------------

const MAX_RETUR_LENGTH = 2048;

/**
 * Godtar kun en sti som *garantert* peker et sted på dette vertsnavnet:
 * starter med nøyaktig én `/`, ikke to (`//evil.com` er protokollrelativ),
 * ikke en backslash (noen nettlesere normaliserer `\` til `/`, og
 * `/\evil.com` ville da blitt protokollrelativ), og ingen kontrolltegn (som
 * kunne smugle en ekstra header inn i redirect-svaret). Alt annet – en
 * absolutt URL, et skjema (`javascript:`, `https:`), tomt – gir `/`.
 *
 * Passordsiden selv gir også `/`: å bli sendt tilbake til skjemaet etter en
 * vellykket innlogging er en blindvei.
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (raw.length > MAX_RETUR_LENGTH) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.toLowerCase().startsWith(ACCESS_GATE_PATH)) return "/";
  return raw;
}

/** Vertsnavnet Caddy så, uten port, med små bokstaver. */
export function cleanHostname(raw: string | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

interface GateContext {
  projectId: string;
  version: string;
  host: string;
  uri: string;
  ip: string;
}

/** Det Caddy-ruten fortalte om forespørselen, eller null om noe mangler. */
function gateContext(c: Context): GateContext | null {
  const projectId = c.req.header(ACCESS_HEADERS.project)?.trim() ?? "";
  const version = c.req.header(ACCESS_HEADERS.version)?.trim() ?? "";
  const host = cleanHostname(c.req.header(ACCESS_HEADERS.host));
  if (!projectId || !version || !host) return null;

  return {
    projectId,
    version,
    host,
    uri: c.req.header(ACCESS_HEADERS.uri) ?? "/",
    ip: c.req.header(ACCESS_HEADERS.clientIp)?.trim() || "ukjent",
  };
}

// ---------------------------------------------------------------------------
// Rate limiting på innloggingen.
//
// Tre akser, alle håndhevet: én IP mot ett prosjekt (en som gjetter), én IP
// totalt (en som går fra app til app), og ett prosjekt totalt (et botnett som
// sprer forsøkene på mange IP-er). Faste ett-minutts-vinduer, samme mønster
// som `overRateLimit()` i `services/error-ingest.ts`.
//
// Nøkkelen er prosjekt-ID-en fra ruten, ikke `Host`: et prosjekt med eget
// domene svarer på `*.domenet`, og med `Host: x1.domenet`, `x2.domenet` … ville
// hver forespørsel fått en ny bøtte. IPv6 telles per /64, som er det en kunde
// hos en vanlig leverandør får – ellers er én angriper uendelig mange IP-er.
//
// Et menneske som taster feil et par ganger merker dem aldri.
// ---------------------------------------------------------------------------

const IP_PROJECT_LIMIT_PER_MINUTE = 8;
const IP_LIMIT_PER_MINUTE = 30;
const PROJECT_LIMIT_PER_MINUTE = 30;

/** Hvor lenge en bøtte får stå ubrukt før den ryddes. */
const BUCKET_STALE_MS = 5 * 60_000;

interface Bucket {
  minute: number;
  count: number;
  lastSeen: number;
}

export function makeRateLimiter(limitPerMinute: number) {
  const buckets = new Map<string, Bucket>();

  const overLimit = (key: string, now: number = Date.now()): boolean => {
    const minute = Math.floor(now / 60_000);
    const entry = buckets.get(key);

    if (!entry || entry.minute !== minute) {
      buckets.set(key, { minute, count: 1, lastSeen: now });
      return false;
    }

    entry.count += 1;
    entry.lastSeen = now;
    return entry.count > limitPerMinute;
  };

  // IP-nøkler er ikke et lite, lukket sett – uten opprydding vokser kartet med
  // hver nye besøkende så lenge prosessen lever.
  const sweep = (): void => {
    const cutoff = Date.now() - BUCKET_STALE_MS;
    for (const [key, entry] of buckets) {
      if (entry.lastSeen < cutoff) buckets.delete(key);
    }
  };

  return { overLimit, sweep };
}

/**
 * Nøkkelen en IP telles under: IPv4 som den er, IPv6 forkortet til sitt /64.
 * Eksportert for testene.
 */
export function ipBucketKey(ip: string): string {
  const clean = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (!clean.includes(":")) return clean;

  // IPv4-mappet IPv6 (`::ffff:1.2.3.4`) er en IPv4-adresse.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(clean);
  if (mapped) return mapped[1]!;

  const [head = "", tail = ""] = clean.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = clean.includes("::")
    ? 8 - headParts.length - tailParts.length
    : 0;
  const groups = [
    ...headParts,
    ...Array(Math.max(0, missing)).fill("0"),
    ...tailParts,
  ];
  return `${groups
    .slice(0, 4)
    .map((group) => (group || "0").replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

const ipProjectLimiter = makeRateLimiter(IP_PROJECT_LIMIT_PER_MINUTE);
const ipLimiter = makeRateLimiter(IP_LIMIT_PER_MINUTE);
const projectLimiter = makeRateLimiter(PROJECT_LIMIT_PER_MINUTE);

function overLimit(gate: GateContext): boolean {
  const ip = ipBucketKey(gate.ip);
  // Alle tre telles hver gang, også når den første allerede sier nei: ellers
  // kunne en angriper som holder seg under én grense nullstille de andre.
  const a = ipProjectLimiter.overLimit(`${ip}|${gate.projectId}`);
  const b = ipLimiter.overLimit(ip);
  const c = projectLimiter.overLimit(gate.projectId);
  return a || b || c;
}

/**
 * Tak på samtidige bcrypt-sammenligninger, for hele prosessen.
 *
 * Før lå bcrypt i Caddy (Go). Nå kjører den i backend, som også betjener API-et,
 * deploy og adgangssjekken for alle beskyttede apper. Grensene over er per
 * nøkkel; dette er taket som holder selv om noen klarer å spre seg over mange.
 * bcryptjs gir fra seg event-loopen underveis, men CPU-en er den samme.
 */
const MAX_CONCURRENT_BCRYPT = 4;
let activeBcrypt = 0;

/** Kalles én gang ved oppstart (`index.ts`). */
/** Kalles én gang ved oppstart (`index.ts`). */
export function startAccessGateHousekeeping(): void {
  setInterval(() => {
    ipProjectLimiter.sweep();
    ipLimiter.sweep();
    projectLimiter.sweep();
  }, BUCKET_STALE_MS).unref();
}

// ---------------------------------------------------------------------------
// Siden
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Passordsiden. Sier ingenting om hvilket prosjekt den står foran, hvem som
 * eier det eller hva det heter – bare at adressen krever passord. Vertsnavnet
 * står allerede i adresselinja.
 */
export function renderPage(options: { retur: string; error?: string }): string {
  const feil = options.error
    ? `<p class="feil" role="alert">${escapeHtml(options.error)}</p>`
    : "";

  return `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Passord kreves</title>
<style>
  :root{ --ink:#000; --line:#242424; --paper:#fff; --sun-soft:#FFF8D1; --error:#D81E06; }
  *{ box-sizing:border-box; }
  body{
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:var(--paper); color:var(--ink); padding:24px;
    font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
  }
  .card{ width:100%; max-width:360px; border:2px solid var(--line); border-radius:12px; padding:32px 28px; }
  h1{ font-size:22px; font-weight:700; margin:0 0 8px; }
  p.sub{ font-size:14px; color:#555; margin:0 0 24px; line-height:1.5; }
  label{
    display:block; font-size:12px; font-weight:700; margin-bottom:6px;
    text-transform:uppercase; letter-spacing:.04em;
  }
  input[type=password]{
    width:100%; border:2px solid var(--line); border-radius:0; padding:12px 14px;
    font-size:16px; font-family:inherit; background:var(--paper); color:var(--ink);
  }
  input[type=password]:focus{ outline:none; background:var(--sun-soft); }
  button{
    margin-top:16px; width:100%; border:2px solid var(--ink); border-radius:0;
    background:var(--ink); color:#fff; font-size:15px; font-weight:700;
    padding:12px 14px; cursor:pointer; font-family:inherit;
  }
  button:hover{ background:var(--paper); color:var(--ink); border-color:var(--line); }
  button:active{ transform:translateY(1px) scale(.985); }
  .feil{
    margin:0 0 16px; padding:10px 12px; border:2px solid var(--error);
    color:var(--error); font-size:13px; line-height:1.4;
  }
  footer{ margin-top:20px; font-size:12px; color:#888; text-align:center; }
</style>
</head>
<body>
  <main class="card">
    <h1>Passord kreves</h1>
    <p class="sub">Denne siden er beskyttet med passord.</p>
    ${feil}
    <form method="post" action="${ACCESS_GATE_PATH}">
      <label for="passord">Passord</label>
      <input id="passord" name="password" type="password" autofocus autocomplete="current-password" required>
      <input type="hidden" name="retur" value="${escapeHtml(options.retur)}">
      <button type="submit">Lås opp</button>
    </form>
    <footer>Snoat</footer>
  </main>
</body>
</html>
`;
}

/**
 * Headerne på alt denne filen svarer med. Ingen caching (svaret avhenger av
 * cookien), ingen innramming (et passordfelt i en usynlig iframe er
 * klikkekapring), ingen referrer ut, og en CSP som bare slipper inn den
 * innebygde stilen og et skjema tilbake til samme vert.
 */
function pageHeaders(c: Context): void {
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Robots-Tag", "noindex, nofollow");
}

function gatePage(
  c: Context,
  status: 200 | 401 | 403 | 429,
  retur: string,
  error?: string,
): Response {
  pageHeaders(c);
  return c.html(renderPage({ retur, error }), status);
}

/** Største skjema innloggingen leser. Et passord og en sti får god plass. */
const MAX_FORM_BYTES = 8 * 1024;

/**
 * Alle verdiene en cookie har i `Cookie`-headeren, ikke bare den første.
 *
 * En annen app under samme registrerbare domene kan sette en cookie med samme
 * navn og `Domain=snoat.com` (cookie-tossing). `__Host-`-prefikset stenger det
 * i produksjon, men lokalt finnes det ikke, og nettleseren sender uansett alle
 * like navn. Den første ville da vunnet, og den ekte blitt oversett – en
 * innloggingsløkke. Er én av dem gyldig, slipper vi inn.
 */
export function cookieValues(
  header: string | undefined,
  name: string,
): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part
      .slice(index + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (value && values.length < 10) values.push(value);
  }
  return values;
}

// En bcrypt-hash av et passord ingen kjenner. Sammenlignes mot når prosjektet
// mangler hash, slik at svaret tar like lang tid som et ekte feil passord.
const DUMMY_HASH =
  "$2b$12$FCW5FPewctOvEZskCTBpU.EehWcZDcL55LfSj5Nk8VUrCmt8IUQTu";

// ---------------------------------------------------------------------------
// Adgangssjekken
// ---------------------------------------------------------------------------

/**
 * Bygger Hono-instansen. `lookupHash` er med for testene; i drift er det
 * `passwordHashFor()`.
 */
export function createAccessGate(
  lookupHash: (projectId: string) => Promise<string | null> = passwordHashFor,
): Hono {
  const accessGate = new Hono();

  accessGate.all(ACCESS_CHECK_PATH, (c) => {
    const gate = gateContext(c);

    if (gate) {
      const tokens = cookieValues(
        c.req.header("cookie"),
        accessCookieName(isLocalHost(gate.host)),
      );
      if (
        tokens.some((token) =>
          verifyAccessToken(token, gate.projectId, gate.host, gate.version),
        )
      ) {
        return c.body(null, 204);
      }
    }

    // Alt annet – manglende headere, ingen cookie, feil signatur, utløpt,
    // gammelt passord – er samme svar: passordsiden, med adressen klienten ba om
    // som mål etter innlogging.
    return gatePage(c, 401, safeReturnPath(gate?.uri));
  });

  // ---------------------------------------------------------------------------
  // Passordsiden og innloggingen
  // ---------------------------------------------------------------------------

  accessGate.get(ACCESS_GATE_PATH, (c) => {
    if (!gateContext(c)) return c.notFound();
    return gatePage(c, 200, safeReturnPath(c.req.query("retur")));
  });

  accessGate.post(
    ACCESS_GATE_PATH,
    // Et passord og en sti. Uten tak leste `parseBody()` hva som helst inn i
    // minnet – før rate-limiten, i prosessen som også er API-et.
    bodyLimit({
      maxSize: MAX_FORM_BYTES,
      onError: (c) => {
        pageHeaders(c);
        return c.html(
          renderPage({ retur: "/", error: "Skjemaet var for stort." }),
          413,
        );
      },
    }),
    async (c) => {
      const gate = gateContext(c);
      if (!gate) return c.notFound();

      // Et skjema sendt fra en annen side (innloggings-CSRF). Nettlesere sender
      // `Origin` på POST; mangler den, er det ikke en nettleser som kan lures.
      const origin = c.req.header("origin");
      if (origin) {
        let originHost: string | null = null;
        try {
          originHost = new URL(origin).hostname.toLowerCase();
        } catch {
          originHost = null;
        }
        if (originHost !== gate.host) {
          logger.warn(
            { projectId: gate.projectId, host: gate.host },
            "Passordskjema sendt fra en annen opprinnelse",
          );
          return gatePage(c, 403, "/", "Skjemaet må sendes fra denne siden.");
        }
      }

      // Før bodyen leses: en avvist forespørsel skal koste så lite som mulig.
      if (overLimit(gate)) {
        logger.warn(
          { projectId: gate.projectId, host: gate.host, ip: gate.ip },
          "Passordforsøk avvist av rate-limiten",
        );
        c.header("Retry-After", "60");
        return gatePage(
          c,
          429,
          "/",
          "For mange forsøk. Vent et minutt og prøv igjen.",
        );
      }

      const body = await c.req.parseBody().catch(() => null);
      const password =
        typeof body?.password === "string" ? body.password.trim() : "";
      const retur = safeReturnPath(
        typeof body?.retur === "string" ? body.retur : null,
      );

      if (activeBcrypt >= MAX_CONCURRENT_BCRYPT) {
        logger.warn(
          { projectId: gate.projectId, ip: gate.ip },
          "Passordforsøk avvist: for mange samtidige",
        );
        c.header("Retry-After", "5");
        return gatePage(
          c,
          429,
          retur,
          "Mange logger inn akkurat nå. Prøv igjen om et øyeblikk.",
        );
      }

      activeBcrypt += 1;
      let hash: string | null;
      let matches: boolean;
      try {
        hash = await lookupHash(gate.projectId);
        // bcrypt.compare er konstant i tid for en gitt hash. Uten hash
        // sammenligner vi mot en dummy, så et prosjekt uten passord ikke svarer
        // raskere.
        matches = await bcrypt.compare(password, hash ?? DUMMY_HASH);
      } finally {
        activeBcrypt -= 1;
      }
      const ok = hash !== null && password !== "" && matches;

      if (!ok) {
        logger.info(
          { projectId: gate.projectId, host: gate.host, ip: gate.ip },
          "Feil passord på passordsiden",
        );
        return gatePage(c, 401, retur, "Feil passord.");
      }

      // Signert med versjonen fra Caddy-ruten, ikke en utledet fra hashen vi nettopp
      // leste: det er ruten sjekken leser fra. Står ruten på et eldre passord (en
      // ruteskriving feilet), virker innloggingen likevel i stedet for å sende
      // brukeren i ring.
      const local = isLocalHost(gate.host);
      setCookie(
        c,
        accessCookieName(local),
        issueAccessToken(gate.projectId, gate.host, gate.version),
        {
          httpOnly: true,
          // `.snoat.localhost` kjører på HTTP lokalt (se `hostnameUrl()` i
          // `lib/caddy.ts`) – en `Secure`-cookie ville aldri blitt satt der.
          secure: !local,
          sameSite: "Lax",
          path: "/",
          // ALDRI `domain` her. Uten blir cookien host-only: nettleseren sender den
          // bare til nøyaktig dette vertsnavnet, aldri til `.snoat.com` eller til et
          // annet prosjekts adresse.
          maxAge: accessCookieTtlSeconds(),
        },
      );

      pageHeaders(c);
      return c.redirect(retur, 303);
    },
  );

  accessGate.notFound((c) => c.text("Ikke funnet.", 404));

  return accessGate;
}

export const accessGate = createAccessGate();
