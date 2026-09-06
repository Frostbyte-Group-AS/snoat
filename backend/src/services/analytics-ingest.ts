import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { config } from "../config.js";
import { devAliasHostname } from "../lib/caddy.js";
import { lookupCountry } from "../lib/geoip.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { parseUserAgent } from "../lib/user-agent.js";

/**
 * Mottak av Caddys access-logg, og eneste vei inn i analytikk-tabellene.
 *
 * Caddy strømmer én JSON-linje per forespørsel over docker-nettet hit. Vi
 * beriker den, kaster IP-en, aggregerer i minnet i noen sekunder og skriver
 * resultatet som ferdige rollup-rader. En app med 300 000 treff i timen blir
 * dermed én rad, ikke 300 000.
 *
 * **IP-adressen treffer aldri disk.** Loggen går rett fra Caddy til denne
 * prosessen uten å innom filsystemet, og adressen forlater aldri `handleLine()`
 * annet enn som en irreversibel hash. Det er halve personvernargumentet for at
 * modulen kan kjøre uten samtykkebanner.
 */

// ---------------------------------------------------------------------------
// Besøkende-identitet
// ---------------------------------------------------------------------------

/**
 * Saltet som gjør besøkende-hashen anonym i stedet for pseudonym.
 *
 * Det lever kun i minnet, skrives aldri ned, og byttes ved døgnskiftet. Etter
 * rotasjonen finnes det ingen nøkkel i verden som kan koble gårsdagens hash til
 * dagens – og siden IP-en aldri lagres, heller ingen vei tilbake til personen.
 *
 * Prisen er at «unike besøkende» over flere dager blir summen av daglige unike.
 * Samme kompromiss som Plausible og Umami gjør, og det er dokumentert i UI-et.
 */
let salt = randomBytes(32);
let saltDay = "";

function visitorHash(projectId: string, ip: string, userAgent: string, day: string): string {
  if (day !== saltDay) {
    salt = randomBytes(32);
    saltDay = day;
    logger.info({ day }, "Nytt analytics-salt – gårsdagens besøkende kan ikke lenger kobles");
  }

  return createHash("sha256")
    .update(salt)
    .update(projectId)
    .update(ip)
    .update(userAgent)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Vertsnavn → prosjekt
// ---------------------------------------------------------------------------

let hostMap = new Map<string, string>();
let hostMapAt = 0;
let refreshing: Promise<void> | null = null;

async function refreshHostMap(): Promise<void> {
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, custom_domain, parent_project_id, branch");

    if (error) {
      logger.warn({ err: error.message }, "Kunne ikke friske opp vertsnavn-kartet");
      return;
    }

    type Row = {
      id: string;
      name: string;
      custom_domain: string | null;
      parent_project_id: string | null;
      branch: string | null;
    };

    const rows = (data ?? []) as Row[];
    const nameById = new Map(rows.map((row) => [row.id, row.name]));

    const next = new Map<string, string>();
    for (const row of rows) {
      next.set(`${row.name}${config.SNOAT_APP_DOMAIN_SUFFIX}`.toLowerCase(), row.id);
      if (row.custom_domain) next.set(row.custom_domain.toLowerCase(), row.id);

      // En dev-side svarer også på `<gren>.<hovedprosjekt>`. Uten denne linja
      // ville alle treff på den pene adressen falt utenfor kartet og blitt
      // forkastet, og statistikken for dev-siden vært tom uansett hvor mye den
      // ble besøkt.
      const parentName = row.parent_project_id ? nameById.get(row.parent_project_id) : null;
      const alias = parentName && row.branch ? devAliasHostname(parentName, row.branch) : null;
      if (alias) next.set(alias.toLowerCase(), row.id);
    }

    hostMap = next;
    hostMapAt = Date.now();
  })().finally(() => {
    refreshing = null;
  });

  return refreshing;
}

/**
 * Tømmer kartet slik at neste treff leser på nytt.
 *
 * Kalles fra deploy-pipelinen når en rute opprettes eller et eget domene
 * endres. Uten den ville de første forespørslene til et helt nytt prosjekt
 * blitt forkastet fram til den periodiske oppfriskningen rakk å kjøre.
 */
export function invalidateHostMap(): void {
  hostMapAt = 0;
}

function resolveProject(host: string): string | null {
  // Caddy tar med porten på ikke-standard porter (typisk lokalt).
  const clean = host.toLowerCase().replace(/:\d+$/, "");

  const known = hostMap.get(clean);
  if (known) return known;

  // Ukjent vert kan være et prosjekt som nettopp ble deployet. Frisk opp, men
  // ikke oftere enn hvert 10. sekund – ellers blir en portscan mot tilfeldige
  // vertsnavn til en spørring per forespørsel.
  if (Date.now() - hostMapAt > 10_000) void refreshHostMap();

  return null;
}

// ---------------------------------------------------------------------------
// Akkumulatorer
// ---------------------------------------------------------------------------

interface HourlyAgg {
  projectId: string;
  hour: string;
  pageviews: number;
  requests: number;
  bytesOut: number;
  errors4xx: number;
  errors5xx: number;
  durationSumMs: number;
  botRequests: number;
}

const hourly = new Map<string, HourlyAgg>();
const dims = new Map<string, { projectId: string; day: string; dim: string; value: string; hits: number }>();
const visitors = new Map<string, { projectId: string; day: string; hour: string; visitor: string }>();

/** Tak på hvor mange distinkte verdier én dimensjon får bidra med per flush. */
const DIM_CARDINALITY_LIMIT = 500;
const OTHER = "(annet)";

/**
 * Dato i norsk tid, ikke UTC.
 *
 * `visitors_daily.day` og `rollup_dim.day` er norske døgn – alt annet ville gitt
 * en «i dag» som starter kl. 01:00 eller 02:00 for kunden. `sv-SE` er triksinget
 * som gir ISO-formatet YYYY-MM-DD direkte ut av Intl.
 */
const dayFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: config.SNOAT_ANALYTICS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Antall *distinkte* verdier vi har sett per prosjekt/dag/dimensjon i denne flushen. */
const dimCounts = new Map<string, number>();

function recordDim(projectId: string, day: string, dim: string, rawValue: string | null): void {
  const value = (rawValue ?? "").trim().slice(0, 255) || "(ukjent)";

  const key = `${projectId}|${day}|${dim}|${value}`;
  const existing = dims.get(key);
  if (existing) {
    existing.hits += 1;
    return;
  }

  // Verdien er ny. Halen kuttes to steder: her, mot én flush, og nattlig i
  // `analytics_prune` mot hele døgnet. Det første hindrer at en portscan mot
  // tilfeldige stier blåser opp minnet, det andre at den blåser opp tabellen.
  const countKey = `${projectId}|${day}|${dim}`;
  const distinct = dimCounts.get(countKey) ?? 0;

  if (distinct >= DIM_CARDINALITY_LIMIT) {
    const otherKey = `${projectId}|${day}|${dim}|${OTHER}`;
    const other = dims.get(otherKey);
    if (other) other.hits += 1;
    else dims.set(otherKey, { projectId, day, dim, value: OTHER, hits: 1 });
    return;
  }

  dimCounts.set(countKey, distinct + 1);
  dims.set(key, { projectId, day, dim, value, hits: 1 });
}

// ---------------------------------------------------------------------------
// Tolkning av én loggline
// ---------------------------------------------------------------------------

interface CaddyLogLine {
  ts?: number;
  status?: number;
  size?: number;
  duration?: number;
  request?: {
    host?: string;
    uri?: string;
    method?: string;
    remote_ip?: string;
    client_ip?: string;
    headers?: Record<string, string[] | undefined>;
  };
  resp_headers?: Record<string, string[] | undefined>;
}

function firstHeader(headers: Record<string, string[] | undefined> | undefined, name: string): string {
  return headers?.[name]?.[0] ?? "";
}

/** Stien uten query. Query-strenger bærer ofte tokens og har uendelig kardinalitet. */
function normalizePath(uri: string): string {
  const withoutQuery = uri.split("?")[0] ?? "/";
  return withoutQuery.slice(0, 255) || "/";
}

/**
 * Henviseren som vertsnavn, ikke full URL.
 *
 * Full URL fra en ekstern side kan inneholde søkeord og IDer som hverken vi
 * eller kunden har noe å gjøre med. Vertsnavnet er det statistikken faktisk
 * handler om: hvor kom de fra?
 */
function referrerHost(raw: string, selfHost: string): string | null {
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    // Navigasjon inne på egen side er ikke en trafikkilde.
    return host && host !== selfHost ? host : null;
  } catch {
    return null;
  }
}

function handleLine(line: string): void {
  let entry: CaddyLogLine;
  try {
    entry = JSON.parse(line) as CaddyLogLine;
  } catch {
    return;
  }

  const host = entry.request?.host;
  if (!host || typeof entry.status !== "number") return;

  const projectId = resolveProject(host);
  if (!projectId) return;

  const at = new Date((entry.ts ?? Date.now() / 1000) * 1000);
  if (Number.isNaN(at.getTime())) return;

  const hour = new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString();
  const day = dayFormatter.format(at);

  const userAgent = firstHeader(entry.request?.headers, "User-Agent");
  const ua = parseUserAgent(userAgent);

  const bytes = entry.size ?? 0;
  const durationMs = Math.round((entry.duration ?? 0) * 1000);

  const key = `${projectId}|${hour}`;
  let agg = hourly.get(key);
  if (!agg) {
    agg = {
      projectId,
      hour,
      pageviews: 0,
      requests: 0,
      bytesOut: 0,
      errors4xx: 0,
      errors5xx: 0,
      durationSumMs: 0,
      botRequests: 0,
    };
    hourly.set(key, agg);
  }

  // Båndbredden er ekte uansett hvem som brukte den, og den er grunnlaget for
  // forbruksmåling i planene. Boter teller derfor med her – men ingen andre steder.
  agg.bytesOut += bytes;

  if (ua.isBot) {
    agg.botRequests += 1;
    return;
  }

  agg.requests += 1;
  agg.durationSumMs += durationMs;
  if (entry.status >= 400 && entry.status < 500) agg.errors4xx += 1;
  else if (entry.status >= 500) agg.errors5xx += 1;

  // En sidevisning er et HTML-svar. Et bilde eller et API-kall er en
  // forespørsel, men ikke en side noen så på.
  const contentType = firstHeader(entry.resp_headers, "Content-Type");
  const isPage = contentType.startsWith("text/html") && entry.status < 400;
  if (!isPage) return;

  agg.pageviews += 1;

  const ip = entry.request?.client_ip || entry.request?.remote_ip || "";
  if (ip) {
    // Siste gang IP-en finnes i klartekst. Etter denne linjen er den borte.
    const visitor = visitorHash(projectId, ip, userAgent, day);
    const visitorKey = `${projectId}|${day}|${visitor}`;
    if (!visitors.has(visitorKey)) {
      visitors.set(visitorKey, { projectId, day, hour, visitor });
    }
    const country = lookupCountry(ip);
    if (country) recordDim(projectId, day, "country", country);
  }

  // Dimensjonene måles per sidevisning, ikke per forespørsel. Ellers ville en
  // side med 40 bilder telt 40 ganger så tungt i nettleserstatistikken.
  recordDim(projectId, day, "path", normalizePath(entry.request?.uri ?? "/"));
  recordDim(projectId, day, "browser", ua.browser);
  recordDim(projectId, day, "os", ua.os);
  recordDim(projectId, day, "device", ua.device);

  const referrer = referrerHost(firstHeader(entry.request?.headers, "Referer"), host.toLowerCase());
  if (referrer) recordDim(projectId, day, "referrer", referrer);
}

// ---------------------------------------------------------------------------
// Skriving
// ---------------------------------------------------------------------------

interface Payload {
  hourly: unknown[];
  visitors: unknown[];
  dims: unknown[];
}

let retries = 0;
let retained: Payload | null = null;
const MAX_RETRIES = 3;

async function flush(): Promise<void> {
  const payload: Payload = retained ?? {
    hourly: [...hourly.values()].map((h) => ({
      project_id: h.projectId,
      hour: h.hour,
      pageviews: h.pageviews,
      requests: h.requests,
      bytes_out: h.bytesOut,
      errors_4xx: h.errors4xx,
      errors_5xx: h.errors5xx,
      duration_sum_ms: h.durationSumMs,
      bot_requests: h.botRequests,
    })),
    visitors: [...visitors.values()].map((v) => ({
      project_id: v.projectId,
      day: v.day,
      hour: v.hour,
      visitor: v.visitor,
    })),
    dims: [...dims.values()].map((d) => ({
      project_id: d.projectId,
      day: d.day,
      dim: d.dim,
      value: d.value,
      hits: d.hits,
    })),
  };

  if (!retained) {
    hourly.clear();
    visitors.clear();
    dims.clear();
    dimCounts.clear();
  }

  if (payload.hourly.length === 0 && payload.visitors.length === 0 && payload.dims.length === 0) {
    return;
  }

  const { error } = await supabase.rpc("analytics_ingest_batch", { payload });

  if (!error) {
    retained = null;
    retries = 0;
    return;
  }

  // Databasen kan være nede et øyeblikk under en omstart. Vi holder på batchen
  // noen runder, men ikke i det uendelige – analytikk som spiser minnet til
  // plattformen er verre enn analytikk som mister fem sekunder.
  retries += 1;
  if (retries <= MAX_RETRIES) {
    retained = payload;
    logger.warn({ err: error.message, attempt: retries }, "Analytics-skriving feilet, prøver igjen");
  } else {
    retained = null;
    retries = 0;
    logger.error(
      { err: error.message, dropped: payload.hourly.length + payload.dims.length },
      "Analytics-batch forkastet etter gjentatte feil",
    );
  }
}

// ---------------------------------------------------------------------------
// Oppstart
// ---------------------------------------------------------------------------

const MAX_LINE_BYTES = 64 * 1024;

export function startAnalyticsIngest(): void {
  void refreshHostMap();

  const server = net.createServer((socket) => {
    let tail = "";
    socket.setEncoding("utf-8");

    socket.on("data", (chunk: string) => {
      const combined = tail + chunk;
      const lines = combined.split("\n");
      tail = lines.pop() ?? "";

      // En linje som aldri avsluttes ville ellers vokst uten tak.
      if (tail.length > MAX_LINE_BYTES) tail = "";

      for (const line of lines) {
        if (line.length > 0) handleLine(line);
      }
    });

    // Caddy kobler seg til igjen selv. Vi skal bare ikke ta ned prosessen.
    socket.on("error", (err) => logger.warn({ err }, "Loggstrømmen fra Caddy brøt sammen"));
  });

  server.on("error", (err) => logger.error({ err }, "Analytics-ingest kunne ikke lytte"));

  server.listen(config.SNOAT_ANALYTICS_INGEST_PORT, "0.0.0.0", () => {
    logger.info(
      { port: config.SNOAT_ANALYTICS_INGEST_PORT, timezone: config.SNOAT_ANALYTICS_TIMEZONE },
      "Analytics-ingest lytter på Caddy-loggen",
    );
  });

  setInterval(() => void flush(), config.SNOAT_ANALYTICS_FLUSH_MS).unref();

  // Vertsnavn-kartet fanger opp slettede prosjekter og domeneendringer som
  // ikke gikk veien om deploy-pipelinen.
  setInterval(() => void refreshHostMap(), 60_000).unref();

  startPruneSweep();
}

/**
 * Nattlig sletting etter lagringsbegrensning, og kutting av halen i
 * dimensjonstabellen.
 *
 * Intervallet er én time og ikke ett døgn med vilje: en VPS som startes på nytt
 * hver natt ville ellers aldri rukket å kjøre jobben. `analytics_prune` er
 * idempotent, så den koster ingenting når det ikke er noe å slette.
 */
function startPruneSweep(): void {
  const run = async (): Promise<void> => {
    const { data, error } = await supabase.rpc("analytics_prune", {
      p_visitor_days: config.SNOAT_ANALYTICS_VISITOR_RETENTION_DAYS,
      p_rollup_days: config.SNOAT_ANALYTICS_ROLLUP_RETENTION_DAYS,
    });

    if (error) logger.warn({ err: error.message }, "Analytics-opprydding feilet");
    else if (data) logger.info({ pruned: data }, "Analytics-opprydding kjørt");
  };

  setInterval(() => void run(), 60 * 60 * 1000).unref();
  // Første kjøring venter litt, slik at oppstart ikke konkurrerer med
  // rutesynkroniseringen om databasen.
  setTimeout(() => void run(), 5 * 60 * 1000).unref();
}
