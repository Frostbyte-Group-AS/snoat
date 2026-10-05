import { domainToASCII } from "node:url";
import { config } from "../config.js";
import * as caddy from "../lib/caddy.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { Redirect, RedirectStatusCode, RedirectWithDomains } from "../types.js";

/**
 * Omdirigeringer: domener som bare skal sende den besøkende videre.
 *
 * Caddy svarer selv (`caddy.upsertRedirectRoute`), så en omdirigering har ingen
 * container, ingen deployment og ingen plangrense å telle mot. Det eneste den
 * koster er en rute i minnet og et sertifikat per vertsnavn.
 *
 * Databasen er fasit, Caddy er speilet – samme regel som for prosjektene. Caddy
 * kjører med `persist: false`, så `reconcileRedirects()` legger alle rutene inn
 * igjen når backend starter.
 */

export class RedirectError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RedirectError";
  }
}

export const REDIRECT_STATUS_CODES: readonly RedirectStatusCode[] = [301, 302, 307, 308];

/** Domener per omdirigering. Fire domener mot én side er det vanlige; tjue er romslig. */
export const MAX_DOMAINS_PER_REDIRECT = 20;

/**
 * Domener per konto, til sammen. Hvert vertsnavn er et sertifikat hos Let's
 * Encrypt, og en konto som kan legge inn ubegrenset mange navn kan bruke opp
 * kvoten vår.
 */
export const MAX_DOMAINS_PER_ACCOUNT = 200;

const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Gjør det kunden limte inn om til et domene: `https://www.Gammelt.no/om-oss` →
 * `gammelt.no`.
 *
 * `www.` fjernes fordi ruten alltid dekker `www.`-varianten selv
 * (`caddy.redirectHosts`). Uten det ville `www.gammelt.no` gitt ruten
 * `www.www.gammelt.no`, og `gammelt.no` uten www ville ikke svart.
 *
 * Norske tegn er lov: `blåbær.no` blir `xn--blbr-roaf.no`, som er det DNS og
 * sertifikatet faktisk bruker.
 */
export function normalizeDomain(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.replace(/:\d+$/, "").replace(/\.+$/, "");
  if (value.startsWith("www.")) value = value.slice("www.".length);
  return domainToASCII(value) || value;
}

/** Kaster hvis domenet ikke kan omdirigeres. Returnerer det normaliserte navnet. */
export function assertValidDomain(raw: string): string {
  const domain = normalizeDomain(raw);

  if (!DOMAIN_PATTERN.test(domain)) {
    throw new RedirectError(400, "redirect.invalid_domain", `«${raw}» er ikke et gyldig domenenavn.`);
  }

  // Plattformens egne navn. Et `<noe>.snoat.com` er et prosjekt, og `snoat.com`
  // selv er dashboardet – ingen av dem skal kunne kapres av en omdirigering.
  const suffixes = [config.SNOAT_APP_DOMAIN_SUFFIX, ...caddy.extraAppDomainSuffixes];
  for (const suffix of suffixes) {
    if (!suffix) continue;
    if (domain === suffix.slice(1) || domain.endsWith(suffix)) {
      throw new RedirectError(
        400,
        "redirect.platform_domain",
        `«${domain}» hører til Snoat selv og kan ikke omdirigeres.`,
      );
    }
  }

  return domain;
}

/**
 * Målet: en absolutt http(s)-adresse uten brukernavn og passord.
 *
 * `{` og `}` prosent-kodes. Caddy erstatter plassholdere som `{env.NOE}` i
 * header-verdier, og `Location` er en header – et mål med klammeparenteser i
 * spørrestrengen kunne ellers fått Caddy til å skrive ut miljøvariablene sine
 * til hvem som helst som besøkte domenet. WHATWG-URL-en koder dem i stien, men
 * ikke i spørrestrengen eller fragmentet.
 */
export function normalizeTargetUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RedirectError(400, "redirect.invalid_target", `«${raw}» er ikke en gyldig adresse. Ta med https://.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RedirectError(400, "redirect.invalid_target", "Målet må være en http- eller https-adresse.");
  }
  if (url.username || url.password) {
    throw new RedirectError(400, "redirect.invalid_target", "Målet kan ikke inneholde brukernavn eller passord.");
  }

  const href = url.href.replaceAll("{", "%7B").replaceAll("}", "%7D");
  if (href.length > 2048) {
    throw new RedirectError(400, "redirect.invalid_target", "Måladressen er for lang (maks 2048 tegn).");
  }
  return href;
}

export interface RedirectInput {
  name?: string | null;
  targetUrl: string;
  domains: string[];
  statusCode?: number;
  preservePath?: boolean;
  externalRef?: string | null;
}

export type RedirectPatch = Partial<Omit<RedirectInput, "externalRef">>;

interface ValidatedFields {
  name: string;
  target_url: string;
  status_code: RedirectStatusCode;
  preserve_path: boolean;
  domains: string[];
}

function validate(input: RedirectInput): ValidatedFields {
  const domains = [...new Set(input.domains.map(assertValidDomain))];

  if (domains.length === 0) {
    throw new RedirectError(400, "redirect.no_domains", "Legg inn minst ett domene.");
  }
  if (domains.length > MAX_DOMAINS_PER_REDIRECT) {
    throw new RedirectError(
      400,
      "redirect.too_many_domains",
      `En omdirigering kan ha høyst ${MAX_DOMAINS_PER_REDIRECT} domener.`,
    );
  }

  const target_url = normalizeTargetUrl(input.targetUrl);

  // Et mål på et av sine egne domener er en uendelig løkke: nettleseren gir opp
  // etter tjue runder med «for mange omdirigeringer».
  const targetHost = normalizeDomain(new URL(target_url).hostname);
  if (domains.includes(targetHost)) {
    throw new RedirectError(
      400,
      "redirect.loop",
      `Målet ligger på ${targetHost}, som er et av domenene som omdirigeres. Det ville blitt en løkke.`,
    );
  }

  const status_code = (input.statusCode ?? 301) as RedirectStatusCode;
  if (!REDIRECT_STATUS_CODES.includes(status_code)) {
    throw new RedirectError(400, "redirect.invalid_status", "Statuskoden må være 301, 302, 307 eller 308.");
  }

  const name = (input.name ?? "").trim().slice(0, 100) || (domains[0] as string);

  return { name, target_url, status_code, preserve_path: input.preservePath ?? false, domains };
}

function dbError(message: string, error: { message: string }): never {
  logger.error({ err: error }, message);
  throw new Error(`${message}: ${error.message}`);
}

/**
 * Sjekker at ingen andre eier domenene.
 *
 * - En annen omdirigering (også kontoens egne) kan ikke ha samme domene.
 * - Et prosjekt kan ikke ha domenet, eller `www.`-varianten, som eget domene.
 * - Et prosjekt på en **annen** konto kan ikke ha foreldredomenet: et eget domene
 *   dekker `*.domenet`, og en omdirigering står foran apprutene i Caddy. Uten
 *   denne sjekken kunne hvem som helst ta over et subdomene av en annens app.
 *   Kontoens egne prosjekter er greit – da er det et bevisst valg.
 */
async function assertDomainsFree(userId: string, domains: string[], redirectId: string | null): Promise<void> {
  const { data: taken, error } = await supabase
    .from("redirect_domains")
    .select("domain, redirect_id")
    .in("domain", domains);
  if (error) dbError("Kunne ikke sjekke domenene", error);

  const clash = (taken ?? []).find((row) => row.redirect_id !== redirectId);
  if (clash) {
    throw new RedirectError(409, "redirect.domain_taken", `«${clash.domain}» omdirigeres allerede et annet sted.`);
  }

  const candidates = domains.flatMap((domain) => [domain, `www.${domain}`]);
  const { data: projects, error: projectError } = await supabase
    .from("projects")
    .select("name, custom_domain")
    .in("custom_domain", candidates);
  if (projectError) dbError("Kunne ikke sjekke domenene", projectError);

  const project = projects?.[0];
  if (project) {
    throw new RedirectError(
      409,
      "redirect.domain_is_project",
      `«${project.custom_domain}» er eget domene for et prosjekt. Fjern det fra prosjektet først.`,
    );
  }

  const parents = [...new Set(domains.map((domain) => caddy.parentDomain(domain)).filter((p): p is string => !!p))];
  if (parents.length > 0) {
    const { data: owners, error: parentError } = await supabase
      .from("projects")
      .select("custom_domain")
      .in("custom_domain", parents)
      .neq("user_id", userId);
    if (parentError) dbError("Kunne ikke sjekke domenene", parentError);

    const owner = owners?.[0];
    if (owner) {
      throw new RedirectError(
        409,
        "redirect.parent_taken",
        `${owner.custom_domain} og subdomenene tilhører et prosjekt på en annen konto.`,
      );
    }
  }
}

async function assertAccountLimit(userId: string, adding: number, redirectId: string | null): Promise<void> {
  const { data, error } = await supabase
    .from("redirects")
    .select("id, redirect_domains(domain)")
    .eq("user_id", userId);
  if (error) dbError("Kunne ikke telle domenene", error);

  const used = (data ?? [])
    .filter((row) => row.id !== redirectId)
    .reduce((sum, row) => sum + ((row.redirect_domains as unknown[] | null)?.length ?? 0), 0);

  if (used + adding > MAX_DOMAINS_PER_ACCOUNT) {
    throw new RedirectError(
      400,
      "redirect.account_limit",
      `Kontoen kan ha høyst ${MAX_DOMAINS_PER_ACCOUNT} omdirigerte domener til sammen.`,
    );
  }
}

type RedirectRow = Redirect & { redirect_domains: Array<{ domain: string }> | null };

function withDomains(row: RedirectRow): RedirectWithDomains {
  const { redirect_domains, ...redirect } = row;
  return { ...redirect, domains: (redirect_domains ?? []).map((d) => d.domain).sort() };
}

const SELECT = "*, redirect_domains(domain)";

export async function listRedirects(userId: string, externalRef?: string): Promise<RedirectWithDomains[]> {
  let query = supabase.from("redirects").select(SELECT).eq("user_id", userId);
  if (externalRef) query = query.eq("external_ref", externalRef);

  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) dbError("Kunne ikke hente omdirigeringene", error);
  return ((data ?? []) as RedirectRow[]).map(withDomains);
}

export async function getOwnedRedirect(userId: string, redirectId: string): Promise<RedirectWithDomains> {
  const { data, error } = await supabase.from("redirects").select(SELECT).eq("id", redirectId).maybeSingle();
  if (error) dbError("Kunne ikke hente omdirigeringen", error);

  const row = data as RedirectRow | null;
  if (!row || row.user_id !== userId) {
    throw new RedirectError(404, "redirect.not_found", "Omdirigeringen finnes ikke.");
  }
  return withDomains(row);
}

async function syncRoute(redirect: RedirectWithDomains): Promise<void> {
  try {
    await caddy.upsertRedirectRoute(
      redirect.id,
      redirect.domains,
      redirect.target_url,
      redirect.status_code,
      redirect.preserve_path,
    );
  } catch (error) {
    logger.error({ redirectId: redirect.id, err: error }, "Kunne ikke skrive omdirigeringen til Caddy");
    throw new RedirectError(
      502,
      "redirect.route_failed",
      "Omdirigeringen ble lagret, men Caddy tok ikke imot ruten. Prøv å lagre på nytt.",
    );
  }
}

/**
 * Oppretter en omdirigering, eller oppdaterer den som har samme `externalRef`.
 *
 * Idempotent på samme måte som `POST /api/projects`: en integrasjon kan sende
 * samme kall på nytt uten å vite om forrige forsøk kom fram.
 */
export async function createRedirect(
  userId: string,
  input: RedirectInput,
): Promise<{ redirect: RedirectWithDomains; created: boolean }> {
  const externalRef = input.externalRef?.trim() || null;
  if (externalRef && externalRef.length > 200) {
    throw new RedirectError(400, "redirect.invalid_ref", "«externalRef» kan være høyst 200 tegn.");
  }

  if (externalRef) {
    const [existing] = await listRedirects(userId, externalRef);
    if (existing) {
      return { redirect: await updateRedirect(userId, existing.id, input), created: false };
    }
  }

  const fields = validate(input);
  await assertDomainsFree(userId, fields.domains, null);
  await assertAccountLimit(userId, fields.domains.length, null);

  const { domains, ...row } = fields;
  const { data, error } = await supabase
    .from("redirects")
    .insert({ ...row, user_id: userId, external_ref: externalRef })
    .select("id")
    .single();
  if (error) dbError("Kunne ikke lagre omdirigeringen", error);

  const id = (data as { id: string }).id;
  const { error: domainError } = await supabase
    .from("redirect_domains")
    .insert(domains.map((domain) => ({ domain, redirect_id: id })));

  if (domainError) {
    // Primærnøkkelen på domenet: noen rakk å ta det mellom sjekken og skrivingen.
    await supabase.from("redirects").delete().eq("id", id);
    if (domainError.code === "23505") {
      throw new RedirectError(409, "redirect.domain_taken", "Et av domenene ble tatt i bruk et annet sted akkurat nå.");
    }
    dbError("Kunne ikke lagre domenene", domainError);
  }

  const redirect = await getOwnedRedirect(userId, id);
  await syncRoute(redirect);
  logger.info({ userId, redirectId: id, domains, target: row.target_url }, "Omdirigering opprettet");
  return { redirect, created: true };
}

export async function updateRedirect(
  userId: string,
  redirectId: string,
  patch: RedirectPatch,
): Promise<RedirectWithDomains> {
  const current = await getOwnedRedirect(userId, redirectId);

  const fields = validate({
    name: patch.name === undefined ? current.name : patch.name,
    targetUrl: patch.targetUrl ?? current.target_url,
    domains: patch.domains ?? current.domains,
    statusCode: patch.statusCode ?? current.status_code,
    preservePath: patch.preservePath ?? current.preserve_path,
  });

  const added = fields.domains.filter((domain) => !current.domains.includes(domain));
  const removed = current.domains.filter((domain) => !fields.domains.includes(domain));

  if (added.length > 0) {
    await assertDomainsFree(userId, added, redirectId);
    await assertAccountLimit(userId, fields.domains.length, redirectId);
  }

  const { domains: _domains, ...row } = fields;
  const { error } = await supabase
    .from("redirects")
    .update({ ...row, updated_at: new Date().toISOString() })
    .eq("id", redirectId);
  if (error) dbError("Kunne ikke lagre omdirigeringen", error);

  if (added.length > 0) {
    const { error: addError } = await supabase
      .from("redirect_domains")
      .insert(added.map((domain) => ({ domain, redirect_id: redirectId })));
    if (addError?.code === "23505") {
      throw new RedirectError(409, "redirect.domain_taken", "Et av domenene ble tatt i bruk et annet sted akkurat nå.");
    }
    if (addError) dbError("Kunne ikke lagre domenene", addError);
  }

  if (removed.length > 0) {
    const { error: removeError } = await supabase
      .from("redirect_domains")
      .delete()
      .eq("redirect_id", redirectId)
      .in("domain", removed);
    if (removeError) dbError("Kunne ikke fjerne domenene", removeError);
  }

  const redirect = await getOwnedRedirect(userId, redirectId);
  await syncRoute(redirect);
  logger.info({ userId, redirectId, added, removed, target: redirect.target_url }, "Omdirigering endret");
  return redirect;
}

/** Fjerner ruten først, så raden. Feiler Caddy, står raden igjen – og sier ifra. */
export async function deleteRedirect(userId: string, redirectId: string): Promise<void> {
  await getOwnedRedirect(userId, redirectId);

  try {
    await caddy.removeRedirectRoute(redirectId);
  } catch (error) {
    logger.error({ redirectId, err: error }, "Kunne ikke fjerne omdirigeringen fra Caddy");
    throw new RedirectError(502, "redirect.route_failed", "Caddy tok ikke imot slettingen. Prøv igjen.");
  }

  const { error } = await supabase.from("redirects").delete().eq("id", redirectId);
  if (error) dbError("Kunne ikke slette omdirigeringen", error);
  logger.info({ userId, redirectId }, "Omdirigering slettet");
}

/**
 * Hvilken omdirigering et vertsnavn hører til, for TLS-sjekken.
 *
 * `www.`-varianten slås opp på domenet uten www, siden det er slik den lagres.
 */
export async function redirectForHostname(hostname: string): Promise<{ id: string } | null> {
  const domain = hostname.startsWith("www.") ? hostname.slice("www.".length) : hostname;
  const { data, error } = await supabase
    .from("redirect_domains")
    .select("redirect_id")
    .eq("domain", domain)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { id: (data as { redirect_id: string }).redirect_id } : null;
}

/**
 * Legger alle omdirigeringene inn i Caddy igjen, og fjerner ruter for
 * omdirigeringer som ikke finnes lenger. Kjøres ved oppstart, etter
 * `reconcileRoutes()`.
 */
export async function reconcileRedirects(): Promise<{ restored: number; removed: number }> {
  const { data, error } = await supabase.from("redirects").select(SELECT);
  if (error) throw new Error(`Kunne ikke lese omdirigeringene: ${error.message}`);

  const redirects = ((data ?? []) as RedirectRow[]).map(withDomains);
  let restored = 0;

  for (const redirect of redirects) {
    if (redirect.domains.length === 0) continue;
    try {
      await caddy.upsertRedirectRoute(
        redirect.id,
        redirect.domains,
        redirect.target_url,
        redirect.status_code,
        redirect.preserve_path,
      );
      restored += 1;
    } catch (err) {
      logger.error({ redirectId: redirect.id, err }, "Kunne ikke gjenopprette omdirigering");
    }
  }

  const known = new Set(redirects.map((redirect) => redirect.id));
  let removed = 0;
  for (const id of await caddy.listRedirectRouteIds()) {
    if (known.has(id)) continue;
    await caddy.removeRedirectRoute(id);
    removed += 1;
  }

  logger.info({ restored, removed }, "Omdirigeringer synkronisert mot Supabase");
  return { restored, removed };
}

/**
 * Om et domene er tatt av en omdirigering, for `PATCH /projects/:id/domain`.
 *
 * Gjelder domenet selv, `www.`-varianten, og – for en annen kontos
 * omdirigeringer – subdomener av det: et eget domene dekker `*.domenet`, og en
 * fremmed omdirigering der ville stått foran appen i Caddy.
 */
export async function domainClashesWithRedirect(userId: string, customDomain: string): Promise<string | null> {
  const bare = customDomain.startsWith("www.") ? customDomain.slice("www.".length) : customDomain;

  const { data: exact, error } = await supabase
    .from("redirect_domains")
    .select("domain")
    .in("domain", [...new Set([customDomain, bare])]);
  if (error) throw new Error(error.message);
  if (exact?.[0]) return (exact[0] as { domain: string }).domain;

  const { data: below, error: belowError } = await supabase
    .from("redirect_domains")
    .select("domain, redirects!inner(user_id)")
    .like("domain", `%.${customDomain}`)
    .neq("redirects.user_id", userId)
    .limit(1);
  if (belowError) throw new Error(belowError.message);
  return below?.[0] ? (below[0] as { domain: string }).domain : null;
}
