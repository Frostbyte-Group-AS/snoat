import * as caddy from "../lib/caddy.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { VpsDomain } from "../types.js";
import { RedirectError, assertValidDomain, normalizeDomain } from "./redirects.js";
import { VpsError, getVps, listVps, vpsKonfigurert } from "./vps.js";

/**
 * VPS-domener: `https://<domene>` → `<vps-ip>:<port>` på VPS-nettet.
 *
 * Tvillingen til omdirigeringene (`services/redirects.ts`). Der svarer Caddy
 * selv med en `Location`; her sender den forespørselen videre til en tjeneste
 * inne i en VPS, f.eks. en FastAPI på :8000. Snoat-VM-en (10.10.10.10) når
 * VPS-nettet (10.10.10.100–250) direkte, så det trengs ingen ny port på verten.
 *
 * Databasen er fasit, Caddy er speilet. Caddy kjører med `persist: false`, så
 * `reconcileVpsDomener()` legger rutene inn igjen når backend starter.
 *
 * IP-en hentes fra Proxmox ut fra vmid hver gang domenet lagres og ved oppstart.
 * Kolonnen `ip` er bare sist kjente verdi – den gjør at ruten kommer tilbake selv
 * om Proxmox ikke svarer akkurat når backend starter.
 *
 * VPS-er finnes bare for eierkontoen; sjekken sitter i `routes/vps.ts`.
 */

export interface VpsDomene extends VpsDomain {
  /** `https://<domene>` – det man åpner i nettleseren. */
  url: string;
}

/** Gjør en rad om til det API-et svarer med. */
function medUrl(row: VpsDomain): VpsDomene {
  return { ...row, url: caddy.hostnameUrl(row.domain) };
}

/** `<ip>:<port>` – det Caddy kobler til. */
export function upstreamFor(ip: string, port: number): string {
  return `${ip}:${port}`;
}

export function gyldigPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Samme normalisering og validering som omdirigeringene, slik at et domene
 * sammenlignes likt på tvers av de to tabellene: `https://www.Von.osia.no/` →
 * `von.osia.no`, og Snoats egne navn avvises.
 */
export function vpsDomene(raw: string): string {
  try {
    return assertValidDomain(raw);
  } catch (error) {
    if (!(error instanceof RedirectError)) throw error;
    const message =
      error.code === "redirect.platform_domain"
        ? `«${normalizeDomain(raw)}» hører til Snoat selv og kan ikke kobles til en VPS.`
        : error.message;
    throw new VpsError(error.status, message, error.code.replace(/^redirect\./, "vps."));
  }
}

function dbError(message: string, error: { message: string }): never {
  logger.error({ err: error }, message);
  throw new Error(`${message}: ${error.message}`);
}

/**
 * Sjekker at ingen andre eier domenet. Samme regler som `assertDomainsFree` for
 * omdirigeringene:
 *
 * - En omdirigering kan ikke ha samme domene – begge står først i Caddy, og da
 *   ville rekkefølgen mellom dem avgjort hvem som svarte.
 * - Et prosjekt kan ikke ha domenet, eller `www.`-varianten, som eget domene.
 * - Et prosjekt på en **annen** konto kan ikke ha foreldredomenet: et eget domene
 *   dekker `*.domenet`, og VPS-ruten står foran. Kontoens egne prosjekter er greit
 *   – `von.osia.no` ved siden av prosjektet `osia.no` er nettopp brukstilfellet.
 *
 * Et annet VPS-domene med samme navn sjekkes av kalleren, som vet om raden er
 * dens egen.
 */
async function assertDomeneLedig(userId: string, domain: string): Promise<void> {
  const { data: redirect, error: redirectError } = await supabase
    .from("redirect_domains")
    .select("domain")
    .eq("domain", domain)
    .maybeSingle();
  if (redirectError) dbError("Kunne ikke sjekke domenet", redirectError);
  if (redirect) {
    throw new VpsError(409, `«${domain}» omdirigeres allerede. Fjern omdirigeringen først.`, "vps.domain_is_redirect");
  }

  const { data: projects, error: projectError } = await supabase
    .from("projects")
    .select("custom_domain")
    .in("custom_domain", [domain, `www.${domain}`]);
  if (projectError) dbError("Kunne ikke sjekke domenet", projectError);
  const project = projects?.[0] as { custom_domain: string } | undefined;
  if (project) {
    throw new VpsError(
      409,
      `«${project.custom_domain}» er eget domene for et prosjekt. Fjern det fra prosjektet først.`,
      "vps.domain_is_project",
    );
  }

  const parent = caddy.parentDomain(domain);
  if (parent) {
    const { data: owners, error: parentError } = await supabase
      .from("projects")
      .select("custom_domain")
      .eq("custom_domain", parent)
      .neq("user_id", userId)
      .limit(1);
    if (parentError) dbError("Kunne ikke sjekke domenet", parentError);
    if (owners?.[0]) {
      throw new VpsError(
        409,
        `${parent} og subdomenene tilhører et prosjekt på en annen konto.`,
        "vps.parent_taken",
      );
    }
  }
}

export async function listVpsDomener(userId: string, vmid?: number): Promise<VpsDomene[]> {
  let query = supabase.from("vps_domains").select("*").eq("user_id", userId);
  if (vmid !== undefined) query = query.eq("vmid", vmid);
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) dbError("Kunne ikke hente VPS-domenene", error);
  return ((data ?? []) as VpsDomain[]).map(medUrl);
}

/** Domenet på denne VPS-en, eid av kontoen. 404 ellers. */
export async function getVpsDomene(userId: string, vmid: number, rawDomain: string): Promise<VpsDomene> {
  const domain = normalizeDomain(rawDomain);
  const { data, error } = await supabase.from("vps_domains").select("*").eq("domain", domain).maybeSingle();
  if (error) dbError("Kunne ikke hente VPS-domenet", error);

  const row = data as VpsDomain | null;
  if (!row || row.user_id !== userId || row.vmid !== vmid) {
    throw new VpsError(404, `«${domain}» er ikke koblet til VPS ${vmid}.`, "vps.domain_not_found");
  }
  return medUrl(row);
}

async function syncRoute(row: VpsDomain): Promise<void> {
  if (!row.ip) {
    throw new VpsError(409, `VPS ${row.vmid} har ingen IP-adresse ennå.`, "vps.no_ip");
  }
  try {
    await caddy.upsertVpsRoute(row.id, row.domain, upstreamFor(row.ip, row.port));
  } catch (error) {
    logger.error({ vpsDomainId: row.id, err: error }, "Kunne ikke skrive VPS-domenet til Caddy");
    throw new VpsError(
      502,
      "Domenet ble lagret, men Caddy tok ikke imot ruten. Prøv å lagre på nytt.",
      "vps.route_failed",
    );
  }
}

/**
 * Kobler et domene til en port på en VPS, eller flytter det hit.
 *
 * Idempotent: samme kall to ganger gir samme rad og samme rute. Er domenet
 * allerede koblet til en annen VPS på kontoen, flyttes det – «sett» betyr sett.
 */
export async function settVpsDomene(
  userId: string,
  vmid: number,
  rawDomain: string,
  port: number,
): Promise<{ domene: VpsDomene; opprettet: boolean }> {
  const domain = vpsDomene(rawDomain);
  if (!gyldigPort(port)) {
    throw new VpsError(400, "Porten må være et heltall mellom 1 og 65535.", "vps.invalid_port");
  }

  // Fra Proxmox, ikke fra det kalleren tror: kaster 404 hvis VPS-en ikke finnes.
  const { ip } = await getVps(vmid);
  if (!ip) {
    throw new VpsError(409, `VPS ${vmid} har ingen IP-adresse ennå.`, "vps.no_ip");
  }

  const { data: existing, error: existingError } = await supabase
    .from("vps_domains")
    .select("*")
    .eq("domain", domain)
    .maybeSingle();
  if (existingError) dbError("Kunne ikke sjekke domenet", existingError);

  const current = existing as VpsDomain | null;
  if (current && current.user_id !== userId) {
    throw new VpsError(409, `«${domain}» er koblet til en VPS på en annen konto.`, "vps.domain_taken");
  }

  await assertDomeneLedig(userId, domain);

  let row: VpsDomain;
  if (current) {
    const { data, error } = await supabase
      .from("vps_domains")
      .update({ vmid, port, ip, updated_at: new Date().toISOString() })
      .eq("id", current.id)
      .select("*")
      .single();
    if (error) dbError("Kunne ikke lagre VPS-domenet", error);
    row = data as VpsDomain;
  } else {
    const { data, error } = await supabase
      .from("vps_domains")
      .insert({ domain, user_id: userId, vmid, port, ip })
      .select("*")
      .single();
    if (error?.code === "23505") {
      // Unik-nøkkelen på domenet: noen rakk å ta det mellom sjekken og skrivingen.
      throw new VpsError(409, `«${domain}» ble tatt i bruk et annet sted akkurat nå.`, "vps.domain_taken");
    }
    if (error) dbError("Kunne ikke lagre VPS-domenet", error);
    row = data as VpsDomain;
  }

  await syncRoute(row);
  logger.info({ userId, vmid, domain, upstream: upstreamFor(ip, port), fraVmid: current?.vmid ?? null }, "VPS-domene satt");
  return { domene: medUrl(row), opprettet: !current };
}

/** Fjerner ruten først, så raden. Feiler Caddy, står raden igjen – og sier ifra. */
export async function fjernVpsDomene(userId: string, vmid: number, rawDomain: string): Promise<void> {
  const row = await getVpsDomene(userId, vmid, rawDomain);

  try {
    await caddy.removeVpsRoute(row.id);
  } catch (error) {
    logger.error({ vpsDomainId: row.id, err: error }, "Kunne ikke fjerne VPS-domenet fra Caddy");
    throw new VpsError(502, "Caddy tok ikke imot slettingen. Prøv igjen.", "vps.route_failed");
  }

  const { error } = await supabase.from("vps_domains").delete().eq("id", row.id);
  if (error) dbError("Kunne ikke slette VPS-domenet", error);
  logger.info({ userId, vmid, domain: row.domain }, "VPS-domene fjernet");
}

/**
 * Fjerner alle domenene til en VPS som er slettet. IP-en kan senere gå til en ny
 * VPS, og et domene som sto igjen ville da pekt på feil maskin.
 *
 * Kaster ikke: VPS-en er allerede borte, og en rest her ryddes ved neste oppstart
 * (`reconcileVpsDomener` legger ikke inn ruter for VPS-er Proxmox ikke kjenner).
 */
export async function fjernDomenerForVmid(vmid: number): Promise<number> {
  const { data, error } = await supabase.from("vps_domains").select("id, domain").eq("vmid", vmid);
  if (error) {
    logger.error({ vmid, err: error }, "Kunne ikke lese domenene til en slettet VPS");
    return 0;
  }

  let removed = 0;
  for (const row of (data ?? []) as Array<{ id: string; domain: string }>) {
    try {
      await caddy.removeVpsRoute(row.id);
      const { error: deleteError } = await supabase.from("vps_domains").delete().eq("id", row.id);
      if (deleteError) throw new Error(deleteError.message);
      removed += 1;
    } catch (err) {
      logger.error({ vmid, domain: row.domain, err }, "Kunne ikke fjerne domenet til en slettet VPS");
    }
  }
  if (removed > 0) logger.info({ vmid, removed }, "Domenene til slettet VPS fjernet");
  return removed;
}

/**
 * Hvilket VPS-domene et vertsnavn hører til, for TLS-sjekken.
 *
 * `www.`-varianten slås opp på domenet uten www, siden det er slik den lagres.
 */
export async function vpsDomeneForHostname(hostname: string): Promise<{ id: string } | null> {
  const domain = hostname.startsWith("www.") ? hostname.slice("www.".length) : hostname;
  const { data, error } = await supabase.from("vps_domains").select("id").eq("domain", domain).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { id: (data as { id: string }).id } : null;
}

/**
 * Om et domene er tatt av et VPS-domene, for `PATCH /projects/:id/domain`.
 *
 * Gjelder domenet selv, `www.`-varianten, og – for en annen kontos VPS-domener –
 * subdomener av det: et eget domene dekker `*.domenet`, og et fremmed VPS-domene
 * der ville stått foran appen i Caddy.
 */
export async function domainClashesWithVps(userId: string, customDomain: string): Promise<string | null> {
  const bare = customDomain.startsWith("www.") ? customDomain.slice("www.".length) : customDomain;

  const { data: exact, error } = await supabase
    .from("vps_domains")
    .select("domain")
    .in("domain", [...new Set([customDomain, bare])])
    .limit(1);
  if (error) throw new Error(error.message);
  if (exact?.[0]) return (exact[0] as { domain: string }).domain;

  const { data: below, error: belowError } = await supabase
    .from("vps_domains")
    .select("domain")
    .like("domain", `%.${customDomain}`)
    .neq("user_id", userId)
    .limit(1);
  if (belowError) throw new Error(belowError.message);
  return below?.[0] ? (below[0] as { domain: string }).domain : null;
}

/**
 * Legger alle VPS-domenene inn i Caddy igjen, og fjerner ruter som ikke har en
 * rad lenger. Kjøres ved oppstart, etter `reconcileRoutes()`.
 *
 * IP-ene hentes fra Proxmox i ett kall. Svarer ikke Proxmox, brukes sist kjente
 * IP fra raden – heller en rute som kanskje peker riktig enn ingen rute. Svarer
 * Proxmox og VPS-en ikke finnes lenger, legges ruten *ikke* inn: IP-en kan ha
 * gått til en annen VPS.
 */
export async function reconcileVpsDomener(): Promise<{ restored: number; removed: number; skipped: number }> {
  const { data, error } = await supabase.from("vps_domains").select("*");
  if (error) throw new Error(`Kunne ikke lese VPS-domenene: ${error.message}`);
  const rows = (data ?? []) as VpsDomain[];

  let ipFor: Map<number, string | null> | null = null;
  if (rows.length > 0 && vpsKonfigurert()) {
    try {
      ipFor = new Map((await listVps()).map((v) => [v.vmid, v.ip]));
    } catch (err) {
      logger.warn({ err }, "Proxmox svarte ikke – VPS-domenene bruker sist kjente IP");
    }
  }

  // Radene som skal ha en rute. En rute som feiler her fjernes ikke – den gamle
  // kan fortsatt stå i Caddy og være riktig.
  const keep = new Set<string>();
  let restored = 0;
  let skipped = 0;

  for (const row of rows) {
    let ip = row.ip;
    if (ipFor) {
      if (!ipFor.has(row.vmid)) {
        logger.warn({ domain: row.domain, vmid: row.vmid }, "VPS-en finnes ikke i Proxmox – ruten legges ikke inn");
        skipped += 1;
        continue;
      }
      const fresh = ipFor.get(row.vmid) ?? null;
      if (fresh && fresh !== ip) {
        const { error: updateError } = await supabase
          .from("vps_domains")
          .update({ ip: fresh, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (updateError) logger.warn({ domain: row.domain, err: updateError }, "Kunne ikke lagre ny IP for VPS-domenet");
        ip = fresh;
      }
    }

    if (!ip) {
      logger.warn({ domain: row.domain, vmid: row.vmid }, "VPS-domenet har ingen IP – ruten legges ikke inn");
      skipped += 1;
      continue;
    }

    keep.add(row.id);
    try {
      await caddy.upsertVpsRoute(row.id, row.domain, upstreamFor(ip, row.port));
      restored += 1;
    } catch (err) {
      logger.error({ domain: row.domain, err }, "Kunne ikke gjenopprette VPS-domene");
    }
  }

  let removed = 0;
  for (const id of await caddy.listVpsRouteIds()) {
    if (keep.has(id)) continue;
    await caddy.removeVpsRoute(id);
    removed += 1;
  }

  logger.info({ restored, removed, skipped }, "VPS-domener synkronisert mot Supabase");
  return { restored, removed, skipped };
}
