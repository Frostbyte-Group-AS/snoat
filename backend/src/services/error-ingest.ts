import { Hono } from "hono";
import { config } from "../config.js";
import { fingerprint, normalizeFile } from "../lib/error-fingerprint.js";
import { resolveProject, startHostMapRefresh } from "../lib/host-map.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { parseUserAgent } from "../lib/user-agent.js";
import { COLLECTOR_JS } from "./error-collector.js";

/**
 * Mottak av feilrapporter, og eneste vei inn i `errors`-tabellene.
 *
 * Speiler `analytics-ingest.ts` bevisst i form: samle i minnet, aggreger der,
 * skriv ferdige rader. Forskjellen er hva som telles. Analytikken teller
 * forespørsler, som er mange og like. Denne teller distinkte feil, som er få og
 * ulike – og der er gruppering, ikke summering, det som gjør datamengden
 * håndterbar.
 *
 * ## Personvern
 *
 * Ingen IP lagres, ikke engang hashet. `visitorHash` finnes ikke her: å telle
 * unike brukere per feil ville krevd en per-person-ID, og en stacktrace med en
 * person knyttet til seg er en helt annen kategori data enn en anonym
 * trafikkstatistikk. Til gjengjeld kan vi ikke svare på «hvor mange er rammet»,
 * kun «hvor ofte skjer det». Det er en pris verdt å betale.
 *
 * User-Agent parses til nettleser og OS og kastes. Query-strengen er allerede
 * fjernet i collectoren, og fjernes igjen her – klienten er ikke tiltrodd.
 */

// ---------------------------------------------------------------------------
// Akkumulatorer
// ---------------------------------------------------------------------------

type Kind = "client" | "server" | "crash" | "http";

interface GroupAgg {
  projectId: string;
  fingerprint: string;
  kind: Kind;
  message: string;
  file: string | null;
  line: number | null;
  col: number | null;
  lastSeen: string;
  events: number;
}

interface EventRow {
  projectId: string;
  fingerprint: string;
  at: string;
  stack: string | null;
  url: string | null;
  browser: string | null;
  os: string | null;
}

const groups = new Map<string, GroupAgg>();
let events: EventRow[] = [];

/**
 * Tak på hvor mange *stacktraces* én flush får bære med seg.
 *
 * Gruppene har ingen tilsvarende grense, fordi de allerede er aggregerte: en
 * app i krasj-løkke gir én gruppe uansett hvor mange ganger den krasjer.
 * Stacktracene er det som kan vokse, og de er også det eneste her som er stort.
 */
const MAX_EVENTS_PER_FLUSH = 200;

/**
 * Rate-limit per prosjekt per minutt.
 *
 * Endepunktet er åpent – det må det være, ellers ville en feil på en
 * passordbeskyttet dev-side aldri blitt rapportert. Uten et tak kunne hvem som
 * helst som kjenner en app-adresse fylt tabellen. Taket er per prosjekt og ikke
 * per IP med vilje: en ekte feil som treffer tusen brukere kommer fra tusen
 * IP-er, og en IP-grense ville sluppet gjennom alt av det og likevel ikke
 * stoppet én angriper med et botnett.
 */
const RATE_LIMIT_PER_MINUTE = 600;
const rate = new Map<string, { minute: number; count: number }>();

function overRateLimit(projectId: string): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  const entry = rate.get(projectId);

  if (!entry || entry.minute !== minute) {
    rate.set(projectId, { minute, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_PER_MINUTE;
}

/**
 * Registrerer én feil. Eneste vei inn i akkumulatorene, uansett om feilen kom
 * fra nettleseren, fra en containers stderr eller fra helsesveipet.
 */
export function recordError(input: {
  projectId: string;
  kind: Kind;
  message: string;
  file?: string | null;
  line?: number | null;
  col?: number | null;
  stack?: string | null;
  url?: string | null;
  browser?: string | null;
  os?: string | null;
  at?: Date;
}): void {
  const message = input.message.trim().slice(0, 500);
  if (!message) return;

  const file = normalizeFile(input.file ?? null);
  const line = Number.isFinite(input.line) ? (input.line as number) : null;
  const at = (input.at ?? new Date()).toISOString();
  const fp = fingerprint(input.kind, message, file, line);

  const key = `${input.projectId}|${fp}`;
  const existing = groups.get(key);

  if (existing) {
    existing.events += 1;
    if (at > existing.lastSeen) {
      existing.lastSeen = at;
      existing.message = message;
    }
  } else {
    groups.set(key, {
      projectId: input.projectId,
      fingerprint: fp,
      kind: input.kind,
      message,
      file,
      line,
      col: Number.isFinite(input.col) ? (input.col as number) : null,
      lastSeen: at,
      events: 1,
    });
  }

  // Stacktracen lagres kun for de første forekomstene i denne flushen. Den
  // hundrede identiske stacktracen sier ikke noe den første ikke sa.
  if (input.stack && events.length < MAX_EVENTS_PER_FLUSH) {
    events.push({
      projectId: input.projectId,
      fingerprint: fp,
      at,
      stack: input.stack.slice(0, 8000),
      url: input.url ?? null,
      browser: input.browser ?? null,
      os: input.os ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// Skriving
// ---------------------------------------------------------------------------

let retained: { groups: unknown[]; events: unknown[] } | null = null;
let retries = 0;
const MAX_RETRIES = 3;

async function flush(): Promise<void> {
  const payload = retained ?? {
    groups: [...groups.values()].map((g) => ({
      project_id: g.projectId,
      fingerprint: g.fingerprint,
      kind: g.kind,
      message: g.message,
      file: g.file,
      line: g.line,
      col: g.col,
      last_seen: g.lastSeen,
      events: g.events,
    })),
    events: events.map((e) => ({
      project_id: e.projectId,
      fingerprint: e.fingerprint,
      at: e.at,
      stack: e.stack,
      url: e.url,
      browser: e.browser,
      os: e.os,
    })),
  };

  if (!retained) {
    groups.clear();
    events = [];
  }

  if (payload.groups.length === 0) return;

  const { error } = await supabase.rpc("errors_ingest_batch", { payload });

  if (!error) {
    retained = null;
    retries = 0;
    return;
  }

  // Samme avveining som i analytics-ingesten: hold på batchen noen runder, men
  // ikke i det uendelige. Feilsporing som spiser minnet til plattformen er verre
  // enn feilsporing som mister ti sekunder.
  retries += 1;
  if (retries <= MAX_RETRIES) {
    retained = payload;
    logger.warn({ err: error.message, attempt: retries }, "Feil-skriving mislyktes, prøver igjen");
  } else {
    retained = null;
    retries = 0;
    logger.error({ err: error.message, dropped: payload.groups.length }, "Feil-batch forkastet");
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Formen collectoren sender. Valideres for hånd og ikke med zod, fordi
 * endepunktet er åpent og skal koste minst mulig per forespørsel – en
 * zod-parse per rapport under en krasj-storm er ikke gratis.
 */
interface Report {
  kind?: unknown;
  message?: unknown;
  file?: unknown;
  line?: unknown;
  col?: unknown;
  stack?: unknown;
  url?: unknown;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

export const errorCollector = new Hono();

/**
 * Collectoren. Cachet i en time hos klienten: den endrer seg sjelden, og en
 * app med mye trafikk skal ikke hente den på nytt for hver sidelast.
 * `no-transform` fordi en mellomliggende proxy som «optimaliserer» JavaScript
 * er nøyaktig det som gjør en feilrapportør til en feilkilde.
 */
errorCollector.get("/__snoat/err.js", (c) => {
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600, no-transform");
  return c.body(COLLECTOR_JS);
});

errorCollector.post("/__snoat/errors", async (c) => {
  // 204 uansett utfall. Endepunktet skal aldri fortelle en fremmed om et
  // vertsnavn er et kjent prosjekt, om taket er nådd, eller om innholdet var
  // gyldig – og collectoren har uansett ingenting fornuftig å gjøre med svaret.
  const noContent = () => c.body(null, 204);

  const host = c.req.header("host");
  if (!host) return noContent();

  const projectId = resolveProject(host);
  if (!projectId) return noContent();

  if (overRateLimit(projectId)) return noContent();

  let body: Report;
  try {
    body = (await c.req.json()) as Report;
  } catch {
    return noContent();
  }

  if (typeof body.message !== "string") return noContent();

  const ua = parseUserAgent(c.req.header("user-agent") ?? "");
  if (ua.isBot) return noContent();

  recordError({
    projectId,
    // Klienten får kun rapportere klientfeil. `crash` og `server` settes av
    // plattformen selv, og en klient som påstår noe annet skal ikke kunne
    // forfalske hvor feilen kom fra.
    kind: "client",
    message: body.message,
    file: typeof body.file === "string" ? body.file : null,
    line: asInt(body.line),
    col: asInt(body.col),
    stack: typeof body.stack === "string" ? body.stack : null,
    url: typeof body.url === "string" ? body.url.split("?")[0]!.slice(0, 255) : null,
    browser: ua.browser,
    os: ua.os,
  });

  return noContent();
});

// ---------------------------------------------------------------------------
// Oppstart
// ---------------------------------------------------------------------------

export function startErrorIngest(): void {
  startHostMapRefresh();

  setInterval(() => void flush(), config.SNOAT_ERRORS_FLUSH_MS).unref();

  // Samme begrunnelse som for analytics-oppryddingen: intervallet er én time og
  // ikke ett døgn, slik at en VPS som startes på nytt hver natt likevel rekker å
  // kjøre jobben. `errors_prune` er idempotent.
  const prune = async (): Promise<void> => {
    const { data, error } = await supabase.rpc("errors_prune", {
      p_event_days: config.SNOAT_ERRORS_EVENT_RETENTION_DAYS,
      p_events_per_group: config.SNOAT_ERRORS_EVENTS_PER_GROUP,
      p_resolved_days: config.SNOAT_ERRORS_RESOLVED_RETENTION_DAYS,
    });

    if (error) logger.warn({ err: error.message }, "Feil-opprydding mislyktes");
    else if (data) logger.info({ pruned: data }, "Feil-opprydding kjørt");
  };

  setInterval(() => void prune(), 60 * 60 * 1000).unref();
  setTimeout(() => void prune(), 6 * 60 * 1000).unref();

  logger.info({ flushMs: config.SNOAT_ERRORS_FLUSH_MS }, "Feil-ingest startet");
}
