import { config } from "../config.js";
import * as caddy from "../lib/caddy.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { Project } from "../types.js";

/**
 * Wildcard-sertifikat for et prosjekts eget domene (`*.<custom_domain>`).
 *
 * Et eget domene dekker subdomenene sine (`routes/tls.ts`), men on-demand gir
 * ett sertifikat per navn, og Let's Encrypt gir høyst 50 nye per registrert
 * domene per uke. MittVel har over 10 000 `<vel>.mittvel.no` – med on-demand
 * ville det tatt fire år. Ett wildcard via DNS-01 dekker alle.
 *
 * DNS-01 krever at Caddy kan legge inn en TXT-oppføring i sonen, så prosjektet
 * gir oss et API-token hos DNS-leverandøren (i dag Cloudflare). Tokenet sjekkes
 * mot leverandøren før det lagres: det må være gyldig og se akkurat denne sonen.
 *
 * Databasen (migrasjon 0024) er fasit, Caddy er speilet. `reconcileWildcardCerts()`
 * legger policyene inn igjen når backend starter.
 */

export class WildcardCertError extends Error {
  constructor(
    readonly status: 400 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = "WildcardCertError";
  }
}

export interface WildcardCertRow {
  project_id: string;
  domain: string;
  dns_provider: "cloudflare";
  api_token: string;
  created_at: string;
  updated_at: string;
}

/** Det API-et viser. Aldri tokenet. */
export interface WildcardCertStatus {
  domain: string;
  dnsProvider: "cloudflare";
  wildcard: string;
  createdAt: string;
  updatedAt: string;
}

export function toStatus(row: WildcardCertRow): WildcardCertStatus {
  return {
    domain: row.domain,
    dnsProvider: row.dns_provider,
    wildcard: `*.${row.domain}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Navnet wildcardet til `domain` dekker: nøyaktig én etikett under domenet.
 * `a.mittvel.no` ja, `a.b.mittvel.no` og `mittvel.no` nei – som i TLS.
 */
export function coveredBy(hostname: string, domain: string): boolean {
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Sjekker et Cloudflare-token: at det er aktivt, og at det ser sonen `domain`.
 * Rettigheten «Zone → DNS → Edit» kan ikke leses ut av API-et uten å skrive, så
 * den oppdages først når Caddy bestiller – feilen havner da i Caddy-loggen.
 */
export async function verifyCloudflareToken(
  apiToken: string,
  domain: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const headers = { Authorization: `Bearer ${apiToken}` };
  let verify: Response;
  let zones: Response;
  try {
    verify = await fetchImpl("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    zones = await fetchImpl(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new WildcardCertError(502, `Fikk ikke kontakt med Cloudflare: ${String(error)}`);
  }

  const verifyBody = (await verify.json().catch(() => null)) as { success?: boolean; result?: { status?: string } } | null;
  if (!verify.ok || !verifyBody?.success || verifyBody.result?.status !== "active") {
    throw new WildcardCertError(400, "Cloudflare godtar ikke tokenet. Sjekk at det er kopiert riktig og er aktivt.");
  }

  const zonesBody = (await zones.json().catch(() => null)) as { success?: boolean; result?: Array<{ name?: string }> } | null;
  const seesZone = zones.ok && zonesBody?.success && (zonesBody.result ?? []).some((zone) => zone.name === domain);
  if (!seesZone) {
    throw new WildcardCertError(
      400,
      `Tokenet ser ikke sonen ${domain} hos Cloudflare. Gi det «Zone → DNS → Edit» for akkurat denne sonen.`,
    );
  }
}

export async function getWildcardCert(projectId: string): Promise<WildcardCertRow | null> {
  const { data, error } = await supabase
    .from("project_wildcard_certs")
    .select("*")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw error;
  return (data as WildcardCertRow | null) ?? null;
}

/** Wildcard-domenet som dekker `hostname`, om noe. Brukes av `tls-ask`. */
export async function wildcardDomainCovering(hostname: string): Promise<string | null> {
  const dot = hostname.indexOf(".");
  if (dot < 0) return null;
  const parent = hostname.slice(dot + 1);
  const { data, error } = await supabase.from("project_wildcard_certs").select("domain").eq("domain", parent).maybeSingle();
  if (error) throw error;
  const domain = (data as { domain: string } | null)?.domain ?? null;
  return domain && coveredBy(hostname, domain) ? domain : null;
}

/**
 * Slår på wildcard for prosjektets eget domene, eller bytter tokenet.
 * Krever `custom_domain`: et wildcard for et domene prosjektet ikke har bevist
 * eierskap til, ville gitt sertifikat for andres subdomener.
 */
export async function setWildcardCert(
  project: Project,
  input: { dnsProvider: string; apiToken: string },
  fetchImpl: FetchLike = fetch,
): Promise<WildcardCertStatus> {
  const domain = project.custom_domain;
  if (!domain) {
    throw new WildcardCertError(409, "Prosjektet må ha et eget domene før det kan få wildcard-sertifikat.");
  }
  if (input.dnsProvider !== "cloudflare") {
    throw new WildcardCertError(400, "Bare Cloudflare støttes som DNS-leverandør foreløpig.");
  }
  const apiToken = input.apiToken.trim();
  if (apiToken.length < 20 || apiToken.length > 200 || /\s/.test(apiToken)) {
    throw new WildcardCertError(400, "Tokenet ser ikke ut som et Cloudflare API-token.");
  }

  await verifyCloudflareToken(apiToken, domain, fetchImpl);

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("project_wildcard_certs")
    .upsert(
      { project_id: project.id, domain, dns_provider: "cloudflare", api_token: apiToken, updated_at: now },
      { onConflict: "project_id" },
    )
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new WildcardCertError(409, `${domain} har allerede wildcard-sertifikat på et annet prosjekt.`);
    }
    throw error;
  }

  try {
    await caddy.upsertWildcardCert(domain, { provider: "cloudflare", apiToken }, config.SNOAT_ACME_EMAIL);
  } catch (err) {
    logger.error({ project: project.name, domain, err }, "Kunne ikke legge inn wildcard-policy i Caddy");
    throw new WildcardCertError(502, "Tokenet er lagret, men Caddy tok ikke imot oppsettet. Det prøves igjen ved neste oppstart.");
  }

  logger.info({ project: project.name, domain }, "Wildcard-sertifikat slått på");
  return toStatus(data as WildcardCertRow);
}

/** Slår av wildcard og sletter tokenet. Subdomenene går tilbake til on-demand. */
export async function removeWildcardCertForProject(project: Project): Promise<boolean> {
  const row = await getWildcardCert(project.id);
  if (!row) return false;

  const { error } = await supabase.from("project_wildcard_certs").delete().eq("project_id", project.id);
  if (error) throw error;

  try {
    await caddy.removeWildcardCert(row.domain);
  } catch (err) {
    logger.warn({ project: project.name, domain: row.domain, err }, "Kunne ikke fjerne wildcard-policy fra Caddy");
  }
  logger.info({ project: project.name, domain: row.domain }, "Wildcard-sertifikat slått av");
  return true;
}

/**
 * Legger alle wildcard-policyene inn i Caddy igjen. Kjøres ved oppstart, før
 * rutene, så ingen handshake for `<x>.domenet` rekker å treffe catch-all-policyen.
 *
 * En rad hvis domene ikke lenger er prosjektets `custom_domain` (domenet er
 * byttet direkte i basen) hoppes over – den gir aldri sertifikat for et domene
 * prosjektet ikke eier.
 */
export async function reconcileWildcardCerts(): Promise<{ restored: number; skipped: number }> {
  const { data, error } = await supabase
    .from("project_wildcard_certs")
    .select("*, projects!inner(custom_domain, name)");
  if (error) throw error;

  let restored = 0;
  let skipped = 0;
  for (const row of (data ?? []) as Array<WildcardCertRow & { projects: { custom_domain: string | null; name: string } }>) {
    if (row.projects.custom_domain !== row.domain) {
      logger.warn({ project: row.projects.name, domain: row.domain }, "Wildcard hoppet over: domenet er ikke prosjektets lenger");
      skipped++;
      continue;
    }
    try {
      await caddy.upsertWildcardCert(row.domain, { provider: row.dns_provider, apiToken: row.api_token }, config.SNOAT_ACME_EMAIL);
      restored++;
    } catch (err) {
      logger.warn({ project: row.projects.name, domain: row.domain, err }, "Kunne ikke gjenopprette wildcard-policy");
      skipped++;
    }
  }
  return { restored, skipped };
}
